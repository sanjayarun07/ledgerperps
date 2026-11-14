# Terraform skeleton (AWS)
Not applied. Validated with OpenTofu only (`tofu init -backend=false && tofu validate` passed; `terraform` binary not installed; no plan/apply run, provider/module versions UNVERIFIED).
Secrets Manager entries are empty containers; populate values out of band; external-secrets (see ../helm) syncs them.
No Nitro chain nodes here: sequencer/validator infra is deliberately out of scope (see ../nitro/README.md).
