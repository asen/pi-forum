// Globals the tests share with their fixtures.

// The agent directory test/fixtures/extension-host.ts reports as Pi's; extension.test.ts sets it.
declare var piForumTestAgentDir: string | undefined

// The stream behind test/fixtures/pi-synthetic.ts's provider; installSyntheticProvider in pi-fixtures.ts
// sets it.
declare var piForumSynthetic: { stream: NonNullable<import('@earendil-works/pi-coding-agent').ProviderConfig['streamSimple']> } | undefined

// What test/fixtures/pi-lifecycle-probe.ts records; pi-integration.test.ts sets it for each host it opens.
declare var piForumProbe: import('./fixtures/pi-lifecycle-probe.ts').LifecycleProbeState | undefined
