# Latency bench — baseline-high

| kind | text | first | last | settle | convo | reasoning | cached% | provider | reply |
|------|------|-------|------|--------|-------|-----------|---------|----------|-------|
| idle | hey | 42.3s | 44.5s | 5.0s | 36.6s | 3439 | 0% | Reka | i'm Irises, call me Iris or Lish / three letters and the whole … |
| task | whats 17% of 2400 | 18.8s | 18.8s | 5.0s | 12.3s | 903 | 77% | Reka | 17% of 2400 is 408 |
| share | finally finished the deck for tomorrow,… | 32.0s | 35.2s | 5.0s | 25.0s | 3197 | 74% | Reka | finally. / sounds like it put up a fight / what's it for tomorr… |
| idle | lol | 41.3s | 41.3s | 5.0s | 35.6s | 3074 | 74% | Reka | the deck lost in the end |
| task | give me a quick 3 step plan to fix my s… | 50.2s | 52.8s | 5.0s | 43.2s | 4018 | 89% | Reka | wake up same time every day, even weekend / no screen one hour … |
| share | had nasi goreng for dinner again | 17.4s | 17.4s | 5.0s | 11.0s | 2829 | 0% | Wafer | how many nights in a row is this? |
| task | what does idempotent mean, one line | 10.9s | 10.9s | 5.0s | 4.6s | 132 | 0% | Reka | same result no matter how many times you run it |
| idle | ok | 25.1s | 25.1s | 5.0s | 19.5s | 1746 | 77% | Reka | still waiting on the nasi goreng count |
| task | rewrite this to sound nicer: send me th… | 16.3s | 16.3s | 5.0s | 9.2s | 621 | 89% | Reka | hey, no rush but send it over when you get a chance |
| share | gym tomorrow at 6am, wish me luck | 19.4s | 21.3s | 5.0s | 13.0s | 405 | 0% | Reka | 6am is a choice / good luck, dont let the snooze win |

**first-bubble overall** — n=10 p50=25.1s p90=50.2s max=50.2s
**first-bubble idle** — n=3 p50=41.3s p90=42.3s max=42.3s
**first-bubble task** — n=4 p50=18.8s p90=50.2s max=50.2s
**first-bubble share** — n=3 p50=19.4s p90=32.0s max=32.0s
