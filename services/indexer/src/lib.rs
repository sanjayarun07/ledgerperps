//! Perps indexer + read API. Derived infrastructure: never authoritative for balances.
// async_trait on fallible methods trips this lint; the Results are consumed by every caller.
#![allow(clippy::double_must_use)]

pub mod api;
pub mod events;
pub mod hub;
pub mod indexer;
pub mod ratelimit;
pub mod redis;
pub mod reindex;
pub mod rpc;
pub mod security;
pub mod ser;
pub mod shared;
pub mod state;
pub mod store;
pub mod tracker;
pub mod ws;

#[cfg(test)]
mod tests;
