<!-- intuition:olympus:start -->
## The component map (Olympus)

This repo is indexed into a component map derived from the compiler, not from guesses.
Prefer it over grepping when you need to know where something lives or what depends on what.

- `olympus_map` — the components and the links between them. Start here to orient.
  Pass `focus` with a block id or name plus `depth` to see one neighbourhood.
- `olympus_entries` — for one component, the symbols other components call, with
  `path:line`. This is the "what crosses this boundary" question.
- `olympus_propose` — draw a component or a link that SHOULD exist but does not yet.
  It records an intention; it never asserts the code is there.
- `olympus_highlight` — dim the user's map to the components you are talking about.
  Use it whenever an answer names specific components; it is a gesture at their
  screen, cleared by their next click.

Blocks are `solid` when the compiler found them and `dashed` when someone only asserted
them. Anything you propose stays dashed until real code exists and the next index finds it,
so build the code as well as the proposal.

The map is a snapshot written by the IDE. If it looks stale, say so rather than working
around it.
<!-- intuition:olympus:end -->
