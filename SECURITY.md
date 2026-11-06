# Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/tungvu-vms/orca-qt-pack/security/advisories/new)
when enabled. If unavailable, contact the repository maintainer privately through
their GitHub profile before sharing exploit details. Do not include passwords,
private keys, tokens, private project source or sensitive logs in public issues.

Reports should identify the plugin/version, operating system, relevant settings,
and a minimal reproduction using non-sensitive sample files. Fixes target the
current catalog release and development branch; no response-time guarantee is made.

Qt Tools and Code Intelligence execute trusted worker code with the user's account
access. Interpreter execution, compiler discovery and SSH behavior are described
in [configuration and security](docs/CONFIGURATION.md#security). Treat cloned projects and their environments as
executable code. Disable project environments or automatic SSH discovery when
those workflows are not trusted.

CI scans Git history with Gitleaks and checks source-tree hygiene. Passing these
checks does not establish that all secrets or security defects have been found.
