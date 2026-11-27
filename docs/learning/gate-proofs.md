# Gate proofs

For each gate added for a defect in [defect-register.md](defect-register.md) or a lesson in [lessons.md](lessons.md): the mutation that reintroduced the defect, and how the gate failed on it. Each mutation was made on the finished code, the test run, and the code restored.

## Bare terminals and lines too neat to be natural (2026-11-26)

`test/interiors.test.ts`, run with one mutation at a time:

- **The old neat line:** in `People.standAt` no side offset, in `People.room` one spacing for everyone, and in `People.stepQueues` everyone moving up the moment the line does. "keeps no line to one spacing, one centreline or one way of facing" failed: off the centreline by 0.041 m on average, under the 0.05 m a natural line keeps.
- **Everyone to the line at once:** in `Terminals.manageBoarding` no wait for a boarding group. "sits people waiting at their gates in real seats, one party to a seat, and boards them by groups" failed: a line of 81 parties, over the 55 allowed.
- **Nobody seated:** in `Terminals.atGate` no seats taken. The same test failed: 2.5% of those waiting airside were sitting, under the half required.
