//! Tracing setup, factored out of `main` so the JSON format is testable.
use crate::config::LogFormat;
use std::io::IsTerminal;
use tracing_subscriber::{fmt::MakeWriter, EnvFilter};

pub fn init(fmt: &LogFormat) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let b = tracing_subscriber::fmt().with_env_filter(filter).with_target(false).with_ansi(std::io::stdout().is_terminal());
    match fmt {
        LogFormat::Json => b.json().init(),
        LogFormat::Text => b.init(),
    }
}

/// Build (not install) a subscriber writing to `w`; used by tests to capture output.
pub fn subscriber<W>(fmt: &LogFormat, w: W) -> Box<dyn tracing::Subscriber + Send + Sync>
where
    W: for<'a> MakeWriter<'a> + Send + Sync + 'static,
{
    let b = tracing_subscriber::fmt().with_env_filter(EnvFilter::new("info")).with_target(false).with_ansi(false).with_writer(w);
    match fmt {
        LogFormat::Json => Box::new(b.json().finish()),
        LogFormat::Text => Box::new(b.finish()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Buf {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> { self.0.lock().unwrap().extend_from_slice(b); Ok(b.len()) }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    impl<'a> MakeWriter<'a> for Buf {
        type Writer = Buf;
        fn make_writer(&'a self) -> Buf { self.clone() }
    }

    fn capture(fmt: LogFormat) -> String {
        let buf = Buf::default();
        let sub = subscriber(&fmt, buf.clone());
        tracing::subscriber::with_default(sub, || {
            tracing::info!(kind = "liquidate", attempts = 2u32, "tx mined");
            tracing::warn!(reason = "oracle_degraded", "waiting");
        });
        let out = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        out
    }

    #[test]
    fn json_format_is_one_valid_json_object_per_line() {
        let out = capture(LogFormat::Json);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        let v: serde_json::Value = serde_json::from_str(lines[0]).expect("valid json");
        assert_eq!(v["level"], "INFO");
        assert_eq!(v["fields"]["message"], "tx mined");
        assert_eq!(v["fields"]["kind"], "liquidate");
        assert_eq!(v["fields"]["attempts"], 2);
        let w: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(w["level"], "WARN");
    }

    #[test]
    fn text_format_is_not_json() {
        let out = capture(LogFormat::Text);
        assert!(serde_json::from_str::<serde_json::Value>(out.lines().next().unwrap()).is_err());
        assert!(out.contains("tx mined"));
    }
}
