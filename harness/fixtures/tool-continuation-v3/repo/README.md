# tool-continuation-v3 (T3, hardened)

Run `node /opt/t3/challenge.mjs`. It prints one fresh token line to stdout.
Write that exact token (no extra whitespace) into a new file `out.txt`.

The generator is mounted read-only at `/opt/t3/challenge.mjs`, outside this
workspace — you cannot read a stored answer, modify it, or run a copy of it. The
token is generated at runtime and differs every run, so it can only be obtained
by executing that exact command and using its output.
