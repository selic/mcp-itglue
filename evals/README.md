# LLM evaluations

Evals measure whether a model can actually accomplish IT Glue tasks through this
server's tools — unit tests verify the plumbing, evals verify the tool *design*
(names, descriptions, response shapes) holds up in real use.

Because every IT Glue account contains different data, eval sets are
**per-instance and private**: generate yours locally and do NOT commit it —
questions and answers inevitably embed client names and infrastructure details.
`answers*.xml` and `eval*.xml` files in this directory are gitignored.

## Generating an eval set

Follow the process from Anthropic's [mcp-builder skill](https://github.com/anthropics/skills)
(Phase 4), against your own instance:

1. Connect an MCP client to this server with a **read-only key** (viewer role or
   a restricted IT Glue key).
2. Explore with read-only tools (`itglue_list_organizations`,
   `itglue_list_documents`, `itglue_vector_search`, …).
3. Write 10 questions that are: independent, read-only, multi-step (require
   several tool calls), realistic for an MSP tech, and with a single stable,
   string-verifiable answer.
4. Solve each one yourself through the tools to verify the answer.
5. Save as `eval.local.xml` using the structure in [template.xml](template.xml).

Good question shapes for this server:

- "Which organization's document '<title>' was updated most recently before
  <fixed date>?" (documents + sorting)
- "What VLAN is configured in the '<type>' flexible asset for <org>?" (asset
  types → assets → traits)
- "According to the runbook found when searching for '<paraphrased task>',
  what is step 3?" (vector search + document sections)

## Running

Score by giving a model only the MCP server plus one question at a time and
string-comparing its final answer. The mcp-builder skill ships runnable
scripts for this loop (`scripts/` in the skill repo).
