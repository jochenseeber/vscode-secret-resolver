let signalCount = 0

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
        signalCount++
        console.log(`[TestNodeLaunch] Received ${sig} (${signalCount}/3)`)

        if (signalCount >= 3) {
            console.log("[TestNodeLaunch] Received 3 signals, exiting.")
            process.exit(0)
        }
    })
}

const entries = Object.entries(process.env)
    .filter(([key]) => key.startsWith("TEST_") || key.startsWith("OP_"))
    .sort(([a], [b]) => a.localeCompare(b))

for (const [key, value] of entries) {
    console.log(`${key}=${value}`)
}

setTimeout(() => {}, 300_000)
