# Website Loader — Project Instructions

- For tasks related to this `website_loader` project, default to DeepSeek Flash (provider `deepseek-account`, model `deepseek-flash`) for subagents in most scenarios; code-review subagents are exempt and may use an appropriate review model. This preference does not apply outside this website project.
- For this `website_loader` project, both the orchestrator and executor subagents must invoke `superpower-using-superpowers` and any applicable/requested skills before acting. The user's direct instruction explicitly overrides that skill's default subagent exemption (`SUBAGENT-STOP`).
- When acting as orchestrator, invoke `superpower-receiving-code-review` while evaluating reviewer/executor feedback, and verify each claim against the actual code before asking for changes.
