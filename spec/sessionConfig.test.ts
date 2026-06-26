import * as assert from "node:assert"

import { SECRET_RESOLVER_CONFIG_FIELD, SessionConfigCodec } from "../src/sessionConfig"

suite("sessionConfig", () => {
    test("SessionConfigCodec.build returns undefined when no metadata is needed", () => {
        const result = SessionConfigCodec.build({
            signalOnStop: null,
            accountId: null,
        })

        assert.strictEqual(result, undefined)
    })

    test("SessionConfigCodec.build includes steps and account id", () => {
        const result = SessionConfigCodec.build({
            signalOnStop: [{ delaySec: 0, signal: "TERM" }],
            accountId: "account-id",
        })

        assert.deepStrictEqual(result, {
            steps: [{ delaySec: 0, signal: "TERM" }],
            accountId: "account-id",
        })
    })

    test("SessionConfigCodec.build returns undefined when only account id is absent and no steps", () => {
        const result = SessionConfigCodec.build({
            signalOnStop: null,
            accountId: null,
        })

        assert.strictEqual(result, undefined)
    })

    test("SessionConfigCodec.parse reads valid metadata from launch configuration", () => {
        const result = SessionConfigCodec.parse({
            [SECRET_RESOLVER_CONFIG_FIELD]: {
                steps: [{ delaySec: 5, signal: "KILL" }],
                accountId: "account-id",
            },
        })

        assert.deepStrictEqual(result, {
            steps: [{ delaySec: 5, signal: "KILL" }],
            accountId: "account-id",
        })
    })

    test("SessionConfigCodec.parse ignores invalid or empty metadata", () => {
        assert.strictEqual(SessionConfigCodec.parse({}), undefined)
        assert.strictEqual(
            SessionConfigCodec.parse({
                [SECRET_RESOLVER_CONFIG_FIELD]: {
                    steps: [{ delaySec: -1, signal: "NOPE" }],
                    accountId: "",
                },
            }),
            undefined,
        )
    })
})
