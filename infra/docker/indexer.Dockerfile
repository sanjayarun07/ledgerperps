# UNTESTED TEMPLATE. Context = repo root. Source: services/indexer (Rust per task description; no Cargo.toml existed when written).
# ARG BIN must be set to the real binary name.
FROM rust:1-bookworm AS build
ARG BIN=perp-indexer
WORKDIR /src
COPY services/indexer ./
RUN cargo build --release
RUN cp target/release/${BIN} /indexer-bin
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && apt-get clean && useradd -r -u 10001 indexer
COPY --from=build /indexer-bin /usr/local/bin/indexer
USER 10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/indexer"]
