---
name: onboard-to-codebase
uses:
  skills: [planning-a-change]
  agents: [explorer]
stop_condition: "you can name the architecture, the change pattern, and the test/build commands"
state: ".loadout/state/onboarding.md"
---

# Onboard to a codebase

1. **Read the baseline** — `AGENTS.md` / `CLAUDE.md` / `README`; note stack, commands, conventions.
2. **Map the architecture** — dispatch the `explorer` agent: where do requests enter, where does business logic live, how is data accessed, how are jobs/queues run?
3. **Find the change pattern** — locate a canonical example of the kind of change you'll make and the test that covers it.
4. **Confirm the loop** — run the build and the test suite once to learn the commands and the baseline state.
5. Record findings in the state file so later sessions skip the ramp-up.

Hand-off: explorer returns the map without spending your main context; planning-a-change uses it for the first real change.
