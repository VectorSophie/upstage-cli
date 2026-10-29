# benchmark-v1 / ms1-indirect (dependent tool-result interpretation)

Run `node /opt/bench/ms1.mjs`. It prints one JSON line with a `primary` field
(a service name) and a `ports` map. Write ONLY the port that `ports[primary]`
points to into a new file `out.txt`. You must read `primary` first to know which
port is correct.
