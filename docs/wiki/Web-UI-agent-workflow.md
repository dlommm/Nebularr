# Web UI — multi-agent workflow (contributors)

**Canonical doc:** [WEBUI_AGENT_WORKFLOW.md](https://github.com/OWNER/REPO/blob/main/docs/WEBUI_AGENT_WORKFLOW.md) in the main repository.

## Who this is for

Large Web UI changes in Nebularr can be executed with two **coordinated** roles: a **Task Tracker** (implements milestones) and a **Quality Guardian** (validates before signoff). The canonical doc has the **mermaid** gate flow and **responsibility** lists for each role.

**End users and operators** do not need this page—use [Web-UI](Web-UI) and [WEBUI_FRAMEWORK](https://github.com/OWNER/REPO/blob/main/docs/WEBUI_FRAMEWORK.md) instead.

## Summary of the gates

1. **Gate A** — Implementation for a milestone is complete.  
2. **Gate B** — Tests and smoke checks pass.  
3. **Gate C** — Joint signoff before the milestone is marked done.

Rework loops back to the Task Tracker when a gate fails.

**Full process, evidence expectations, and Quality Guardian checks:** [WEBUI_AGENT_WORKFLOW.md](https://github.com/OWNER/REPO/blob/main/docs/WEBUI_AGENT_WORKFLOW.md). Replace `OWNER/REPO` in links if you mirror this to GitHub wiki.
