//! Minimal Redis client (RESP2 over TCP): just enough to run one atomic token-bucket script. No extra dependency.
//! Supports `redis://[:password@]host[:port][/db]`. TLS (`rediss://`) is not supported.
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

const BUCKET_LUA: &str = r#"
local t_now = redis.call('TIME')
local now = tonumber(t_now[1]) * 1000 + math.floor(tonumber(t_now[2]) / 1000)
local rate = tonumber(ARGV[1]); local burst = tonumber(ARGV[2])
local d = redis.call('HMGET', KEYS[1], 't', 'ts')
local t = tonumber(d[1]); local ts = tonumber(d[2])
if t == nil then t = burst; ts = now end
t = math.min(burst, t + (now - ts) / 1000 * rate)
local ok = 0; local retry = 0
if t >= 1 then t = t - 1; ok = 1 else retry = math.ceil((1 - t) / rate) end
redis.call('HSET', KEYS[1], 't', tostring(t), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000) + 1000)
return {ok, retry}
"#;

#[derive(Debug)]
#[allow(dead_code)]
enum Reply {
    Simple(String),
    Int(i64),
    Bulk(Option<Vec<u8>>),
    Array(Vec<Reply>),
}

pub struct RedisClient {
    addr: String,
    password: Option<String>,
    db: Option<u32>,
    conn: Mutex<Option<BufReader<TcpStream>>>,
    timeout: Duration,
}

impl RedisClient {
    pub fn from_url(url: &str) -> anyhow::Result<Self> {
        let rest = url
            .strip_prefix("redis://")
            .ok_or_else(|| anyhow::anyhow!("REDIS_URL must start with redis:// (rediss:// / TLS is not supported)"))?;
        let (auth, hostpart) = match rest.rsplit_once('@') {
            Some((a, h)) => (Some(a), h),
            None => (None, rest),
        };
        let password = auth.map(|a| a.split_once(':').map(|x| x.1).unwrap_or(a).to_string()).filter(|p| !p.is_empty());
        let (hostport, db) = match hostpart.split_once('/') {
            Some((h, d)) => (h, if d.is_empty() { None } else { Some(d.parse()?) }),
            None => (hostpart, None),
        };
        let addr = if hostport.contains(':') {
            hostport.to_string()
        } else {
            format!("{hostport}:6379")
        };
        Ok(Self {
            addr,
            password,
            db,
            conn: Mutex::new(None),
            timeout: Duration::from_millis(250),
        })
    }

    fn encode(args: &[&[u8]]) -> Vec<u8> {
        let mut b = format!("*{}\r\n", args.len()).into_bytes();
        for a in args {
            b.extend_from_slice(format!("${}\r\n", a.len()).as_bytes());
            b.extend_from_slice(a);
            b.extend_from_slice(b"\r\n");
        }
        b
    }

    async fn read_reply(r: &mut BufReader<TcpStream>) -> anyhow::Result<Reply> {
        let mut line = String::new();
        if r.read_line(&mut line).await? == 0 {
            anyhow::bail!("redis closed the connection");
        }
        let line = line.trim_end_matches(['\r', '\n']);
        let (t, body) = line.split_at(1);
        Ok(match t {
            "+" => Reply::Simple(body.to_string()),
            "-" => anyhow::bail!("redis error: {body}"),
            ":" => Reply::Int(body.parse()?),
            "$" => {
                let n: i64 = body.parse()?;
                if n < 0 {
                    Reply::Bulk(None)
                } else {
                    let mut buf = vec![0u8; n as usize + 2];
                    r.read_exact(&mut buf).await?;
                    buf.truncate(n as usize);
                    Reply::Bulk(Some(buf))
                }
            }
            "*" => {
                let n: i64 = body.parse()?;
                let mut v = Vec::new();
                for _ in 0..n.max(0) {
                    v.push(Box::pin(Self::read_reply(r)).await?);
                }
                Reply::Array(v)
            }
            o => anyhow::bail!("unexpected redis reply type {o:?}"),
        })
    }

    async fn roundtrip(c: &mut BufReader<TcpStream>, args: &[&[u8]]) -> anyhow::Result<Reply> {
        c.get_mut().write_all(&Self::encode(args)).await?;
        Self::read_reply(c).await
    }

    async fn connect(&self) -> anyhow::Result<BufReader<TcpStream>> {
        let s = TcpStream::connect(&self.addr).await?;
        s.set_nodelay(true)?;
        let mut c = BufReader::new(s);
        if let Some(p) = &self.password {
            Self::roundtrip(&mut c, &[b"AUTH", p.as_bytes()]).await?;
        }
        if let Some(d) = self.db {
            Self::roundtrip(&mut c, &[b"SELECT", d.to_string().as_bytes()]).await?;
        }
        Ok(c)
    }

    async fn command(&self, args: &[&[u8]]) -> anyhow::Result<Reply> {
        let mut g = self.conn.lock().await;
        for attempt in 0..2 {
            if g.is_none() {
                *g = Some(tokio::time::timeout(self.timeout, self.connect()).await??);
            }
            let c = g.as_mut().unwrap();
            match tokio::time::timeout(self.timeout, Self::roundtrip(c, args)).await {
                Ok(Ok(r)) => return Ok(r),
                Ok(Err(e)) if attempt == 1 || e.to_string().starts_with("redis error") => {
                    *g = None;
                    return Err(e);
                }
                Ok(Err(_)) => *g = None, // broken pipe etc: reconnect once
                Err(_) => {
                    *g = None;
                    anyhow::bail!("redis timeout");
                }
            }
        }
        anyhow::bail!("redis unavailable")
    }

    pub async fn ping(&self) -> anyhow::Result<()> {
        match self.command(&[b"PING"]).await? {
            Reply::Simple(s) if s == "PONG" => Ok(()),
            o => anyhow::bail!("unexpected PING reply {o:?}"),
        }
    }

    /// Atomic token bucket. `Ok(Ok(()))` = allowed, `Ok(Err(secs))` = limited, `Err` = backend failure.
    pub async fn token_bucket(&self, key: &str, rate: f64, burst: f64) -> anyhow::Result<Result<(), u64>> {
        let r = self
            .command(&[
                b"EVAL",
                BUCKET_LUA.as_bytes(),
                b"1",
                key.as_bytes(),
                rate.to_string().as_bytes(),
                burst.to_string().as_bytes(),
            ])
            .await?;
        match r {
            Reply::Array(v) => match (v.first(), v.get(1)) {
                (Some(Reply::Int(1)), _) => Ok(Ok(())),
                (Some(Reply::Int(_)), Some(Reply::Int(s))) => Ok(Err((*s).max(1) as u64)),
                _ => anyhow::bail!("unexpected EVAL reply shape"),
            },
            other => anyhow::bail!("unexpected EVAL reply {other:?}"),
        }
    }
}
