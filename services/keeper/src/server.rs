//! /metrics, /healthz, /readyz.
use crate::metrics::{unix_now, Health, Metrics};
use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Router};
use std::{net::SocketAddr, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct AppState {
    pub metrics: Arc<Metrics>,
    pub health: Arc<Health>,
    pub max_age_secs: u64,
    pub max_lag: u64,
}

pub fn router(st: AppState) -> Router {
    Router::new().route("/metrics", get(metrics)).route("/healthz", get(healthz)).route("/readyz", get(readyz)).with_state(st)
}

async fn metrics(State(st): State<AppState>) -> impl IntoResponse {
    ([("content-type", "application/openmetrics-text; version=1.0.0; charset=utf-8")], st.metrics.render())
}

async fn healthz() -> impl IntoResponse { (StatusCode::OK, "ok\n") }

async fn readyz(State(st): State<AppState>) -> impl IntoResponse {
    if st.health.ready(unix_now(), st.max_age_secs, st.max_lag) {
        (StatusCode::OK, "ready\n")
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "not ready\n")
    }
}

pub async fn serve(addr: SocketAddr, st: AppState, shutdown: CancellationToken) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "metrics/health server listening");
    axum::serve(listener, router(st)).with_graceful_shutdown(async move { shutdown.cancelled().await }).await?;
    Ok(())
}
