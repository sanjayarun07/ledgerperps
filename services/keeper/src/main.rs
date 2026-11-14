use anyhow::Result;
use clap::Parser;
use perp_keeper::{
    actions::Ctx,
    chain::{log_signer, Chain},
    config::{Cli, Config},
    lock::StateLock,
    keeper::Keeper,
    metrics::{Health, Metrics},
    server::{self, AppState},
    wallet,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("sigterm handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cfg = Config::load(Cli::parse())?;
    perp_keeper::logging::init(&cfg.log_format);
    info!(config = ?cfg, "starting perp-keeper (UNAUDITED prototype)");

    // Exclusive checkpoint ownership: refuse to start if another keeper process uses the same state file.
    let _state_lock = StateLock::acquire(&cfg.state_file)?;
    let signer = wallet::load_signer(&cfg)?;
    if signer.is_none() {
        warn!("no signing key configured: running simulation-only (dry-run)");
    }
    let chain = Arc::new(Chain::connect(&cfg, signer).await?);
    log_signer(chain.from, chain.chain_id(), cfg.dry_run || !chain.can_send());
    if chain.can_send() {
        match chain.balance().await {
            Ok(b) if b.is_zero() => warn!("keeper account has zero native balance: transactions will fail"),
            Ok(_) => {}
            Err(e) => warn!(error = %e, "could not read keeper balance"),
        }
    }

    let cfg = Arc::new(cfg);
    let metrics = Arc::new(Metrics::new());
    let health = Arc::new(Health::default());
    let shutdown = CancellationToken::new();

    let app = AppState {
        metrics: metrics.clone(),
        health: health.clone(),
        max_age_secs: (cfg.poll_interval_ms / 1000) * 5 + 30,
        max_lag: cfg.max_ready_lag_blocks,
    };
    let srv = tokio::spawn(server::serve(cfg.metrics_addr, app, shutdown.clone()));

    {
        let s = shutdown.clone();
        tokio::spawn(async move {
            wait_for_signal().await;
            info!("shutdown signal received; finishing current action");
            s.cancel();
        });
    }

    let ctx = Ctx { cfg: cfg.clone(), chain, metrics };
    let mut keeper = Keeper::new(ctx, health, shutdown.clone()).await?;
    keeper.run().await;
    shutdown.cancel();
    let _ = srv.await;
    Ok(())
}
