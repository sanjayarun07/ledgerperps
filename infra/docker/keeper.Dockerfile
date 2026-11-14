# UNTESTED TEMPLATE. Context = repo root. Source: services/keeper (Rust, bin "perp-keeper" per its Cargo.toml).
FROM rust:1-bookworm AS build
WORKDIR /src
COPY services/keeper ./
RUN cargo build --release --locked
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && apt-get clean && useradd -r -u 10001 keeper
COPY --from=build /src/target/release/perp-keeper /usr/local/bin/perp-keeper
USER 10001
EXPOSE 9102
ENTRYPOINT ["/usr/local/bin/perp-keeper"]
