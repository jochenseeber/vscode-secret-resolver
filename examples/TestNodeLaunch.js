const entries = Object.entries(process.env)
    .filter(([key]) => key.startsWith("TEST_"))
    .sort(([a], [b]) => a.localeCompare(b));

for (const [key, value] of entries) {
    console.log(`${key}=${value}`);
}

setTimeout(() => {}, 60_000);
