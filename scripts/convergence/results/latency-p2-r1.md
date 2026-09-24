# Latency bench — p2-r1

| kind | text | first | last | settle | convo | reasoning | cached% | provider | reply |
|------|------|-------|------|--------|-------|-----------|---------|----------|-------|
| idle | hey | 8.8s | 12.1s | 1.8s | 6.4s | 106 | 0% | Wafer | hey. / four letters, no context. / classic you starting somethi… |
| task | whats 17% of 2400 | 6.0s | 6.0s | 1.8s | 3.8s | 42 | 0% | Wafer | 408 |
| share | finally finished the deck for tomorrow,… | 8.0s | 8.0s | 1.8s | 5.5s | 164 | 69% | Wafer | so the deck finally made it out alive |
| idle | lol | 6.8s | 8.5s | 1.8s | 4.4s | 147 | 77% | Wafer | laughing at your own deck. / brave of you to face it tomorrow |
| task | give me a quick 3 step plan to fix my s… | 5.3s | 9.3s | 1.8s | 2.9s | 51 | 79% | Wafer | wake at same time daily, even weekends / morning sun before 10 … |
| share | had nasi goreng for dinner again | 8.4s | 10.5s | 1.8s | 6.0s | 52 | 77% | Wafer | nasi goreng again huh / at this point its basically your second… |
| task | what does idempotent mean, one line | 4.8s | 4.8s | 1.8s | 2.3s | 6 | 79% | Wafer | do it many time, result stay the same every time |
| idle | ok | 4.9s | 4.9s | 1.8s | 2.8s | 52 | 77% | Wafer | anytime |
| task | rewrite this to sound nicer: send me th… | 6.0s | 6.0s | 1.8s | 3.2s | 96 | 80% | Wafer | hey, whenever you get a sec, can you shoot me the file? |
| share | gym tomorrow at 6am, wish me luck | 12.2s | 16.3s | 1.8s | 9.9s | 501 | 80% | Wafer | 6am gym. / bold move for someone who can't sleep till 2 / good … |

**first-bubble overall** — n=10 p50=6.8s p90=12.2s max=12.2s
**first-bubble idle** — n=3 p50=6.8s p90=8.8s max=8.8s
**first-bubble task** — n=4 p50=6.0s p90=6.0s max=6.0s
**first-bubble share** — n=3 p50=8.4s p90=12.2s max=12.2s
