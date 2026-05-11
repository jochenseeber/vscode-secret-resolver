import * as assert from "node:assert"

import { buildSessionConfig, parseSessionConfig, SECRET_RESOLVER_CONFIG_FIELD } from "../src/sessionConfig"

suite("sessionConfig", () => {
    test("buildSessionConfig returns undefined when no metadata is needed", () => {
        const result = buildSessionConfig({
            signalOnStop: null,
            tokenTag: null,
            useOpRun: false,
            accountId: null,
        })

        assert.strictEqual(result, undefined)
    })

    test("buildSessionConfig includes steps, op-mode token tag, and account id", () => {
        const result = buildSessionConfig({
            signalOnStop: [{ delaySec: 0, signal: "TERM" }],
            tokenTag: "service-token",
            useOpRun: true,
            accountId: "account-id",
        })

        assert.deepStrictEqual(result, {
            steps: [{ delaySec: 0, signal: "TERM" }],
            tokenTag: "service-token",
            accountId: "account-id",
        })
    })

    test("buildSessionConfig omits token tag outside op-run mode", () => {
        const result = buildSessionConfig({
            signalOnStop: null,
            tokenTag: "service-token",
            useOpRun: false,
            accountId: null,
        })

        assert.strictEqual(result, undefined)
    })

    test("parseSessionConfig reads valid metadata from launch configuration", () => {
        const result = parseSessionConfig({
            [SECRET_RESOLVER_CONFIG_FIELD]: {
                steps: [{ delaySec: 5, signal: "KILL" }],
                tokenTag: "service-token",
                accountId: "account-id",
            },
        })

        assert.deepStrictEqual(result, {
            steps: [{ delaySec: 5, signal: "KILL" }],
            tokenTag: "service-token",
            accountId: "account-id",
        })
    })

    test("parseSessionConfig ignores invalid or empty metadata", () => {
        assert.strictEqual(parseSessionConfig({}), undefined)
        assert.strictEqual(
            parseSessionConfig({
                [SECRET_RESOLVER_CONFIG_FIELD]: {
                    steps: [{ delaySec: -1, signal: "NOPE" }],
                    tokenTag: "",
                    accountId: "",
                },
            }),
            undefined,
        )
    })
})
