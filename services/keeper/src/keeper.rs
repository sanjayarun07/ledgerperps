//! Orchestrator: one poll cycle = scan logs -> funding -> liquidation -> conditionals -> TWAP -> ADL -> write-off -> checkpoint.
use crate::{
    actions::{Ctx, Marks},
    features::{adl, conditional, funding, liquidation, sync_backstop, twap, writeoff},
    metrics::Health,
    scanner,
    state::State,
};
use alloy::primitives::B256;
use anyhow::Result;
use std::{collections::HashMap, sync::Arc, time::{Duration, Instant}};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

pub struct Keeper {
    pub ctx: Ctx,
    pub state: State,
    pub health: Arc<Health>,
    pub shutdown: CancellationToken,
    backstop: B256,
    /// Per-market time of the last funding poke (each market has its own `fundingInterval`).
    last_funding: HashMap<u8, Instant>,
    sync: sync_backstop::SyncState,
}

impl Keeper {
    pub async fn new(ctx: Ctx, health: Arc<Health>, shutdown: CancellationToken) -> Result<Keeper> {
        let backstop = ctx.chain.backstop().await?;
        let exch = format!("{:#x}", ctx.cfg.exchange);
        let state = match State::load(&ctx.cfg.state_file, &exch) {
            Some(s) => {
                info!(next_block = s.next_block, accounts = s.accounts.len(), conds = s.conds.len(), twaps = s.twaps.len(), "resumed from checkpoint");
                s
            }
            None => {
                info!(start_block = ctx.cfg.start_block, "no usable checkpoint; starting fresh");
                State::new(exch, ctx.cfg.start_block)
            }
        };
        Ok(Keeper { ctx, state, health, shutdown, backstop, last_funding: HashMap::new(), sync: Default::default() })
    }

    pub async fn run(&mut self) {
        let poll = Duration::from_millis(self.ctx.cfg.poll_interval_ms);
        loop {
            match self.tick().await {
                Ok(()) => {
                    self.ctx.metrics.ticks.inc();
                }
                Err(e) => {
                    self.ctx.metrics.tick_errors.inc();
                    error!(error = %format!("{e:#}"), "poll cycle failed");
                }
            }
            tokio::select! {
                _ = self.shutdown.cancelled() => break,
                _ = tokio::time::sleep(poll) => {}
            }
        }
        self.persist();
        info!("keeper stopped; checkpoint saved");
    }

    fn persist(&self) {
        if let Err(e) = self.state.save(&self.ctx.cfg.state_file) {
            warn!(error = %format!("{e:#}"), "failed to save checkpoint");
        }
    }

    fn stopping(&self) -> bool { self.shutdown.is_cancelled() }

    pub async fn tick(&mut self) -> Result<()> {
        let head = self.ctx.chain.head().await?;
        let m = &self.ctx.metrics;
        m.head_block.set(head.number as i64);
        let safe = head.number.saturating_sub(self.ctx.cfg.confirmations);
        m.rpc_active_endpoint.set(self.ctx.chain.health_check().await as i64);
        m.multicall_enabled.set(self.ctx.chain.multicall_enabled() as i64);

        // 1) discovery (verifies the block-hash chain and rolls back on reorg)
        match scanner::scan(&self.ctx, &mut self.state, safe, &self.backstop).await {
            Ok(r) => {
                if let Some(anc) = r.rolled_back_to {
                    m.reorgs.inc();
                    warn!(common_ancestor = anc, depth = r.reorg_depth, "reorg handled: scan cursor and tracked state rolled back");
                }
            }
            Err(e) => warn!(error = %format!("{e:#}"), "log scan incomplete; will resume from checkpoint"),
        }
        let scanned = self.state.next_block.saturating_sub(1);
        let lag = head.number.saturating_sub(scanned);
        m.scanned_block.set(scanned as i64);
        m.head_lag.set(lag as i64);
        m.accounts_tracked.set(self.state.accounts.len() as i64);
        m.conds_tracked.set(self.state.conds.len() as i64);
        m.twaps_tracked.set(self.state.twaps.len() as i64);

        let n = self.ctx.chain.market_count().await?;
        let mut marks = Marks::default();
        let cfg = self.ctx.cfg.clone();

        // 2) funding
        if cfg.enable_funding && !self.stopping() {
            funding::run(&self.ctx, n, &mut self.last_funding).await;
        }
        // 3) liquidations
        if cfg.enable_liquidation && !self.stopping() {
            liquidation::run(&self.ctx, &mut self.state, &mut marks, n).await;
        }
        m.accounts_with_positions.set(self.state.accounts_with_positions() as i64);
        // 4) conditional orders
        if cfg.enable_conditional && !self.stopping() {
            conditional::run(&self.ctx, &mut self.state, &mut marks).await;
        }
        // 5) TWAP
        if cfg.enable_twap && !self.stopping() {
            twap::run(&self.ctx, &mut self.state, head.timestamp).await;
        }
        // 5b) record the backstop's mark-to-market deficit before ADL needs the debt on the books
        if cfg.enable_sync_backstop && !self.stopping() {
            sync_backstop::run(&self.ctx, &mut self.sync, n, self.backstop).await;
        }
        // 6) ADL
        if cfg.enable_adl && !self.stopping() {
            adl::run(&self.ctx, &self.state, n, self.backstop).await;
        }

        // 7) write-off sweep of flat negative accounts (LIQ-2)
        if cfg.enable_writeoff && !self.stopping() {
            writeoff::run(&self.ctx, &mut self.state, n, self.backstop).await;
        }

        self.persist();
        self.health.mark_ok(lag);
        Ok(())
    }
}
