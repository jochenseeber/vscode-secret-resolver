import * as assert from "node:assert"

import { StringEnvMap } from "../src/stringEnvMap"

suite("StringEnvMap constructor", () => {
    test("stores plain string values", () => {
        const env = new StringEnvMap({ A: "x", B: "y" })
        assert.strictEqual(env.getValue("A"), "x")
        assert.strictEqual(env.getValue("B"), "y")
    })

    test("drops null values", () => {
        const env = new StringEnvMap({ A: null })
        assert.strictEqual(env.getValue("A"), undefined)
    })

    test("drops undefined values", () => {
        const env = new StringEnvMap({ A: undefined })
        assert.strictEqual(env.getValue("A"), undefined)
    })

    test("empty record produces empty map", () => {
        const env = new StringEnvMap({})
        assert.strictEqual(env.size, 0)
    })

    test("no-argument constructor produces empty map", () => {
        const env = new StringEnvMap()
        assert.strictEqual(env.size, 0)
    })
})

suite("StringEnvMap.getValue / setValue", () => {
    test("getValue returns undefined for missing key", () => {
        assert.strictEqual(new StringEnvMap().getValue("X"), undefined)
    })

    test("setValue stores and getValue retrieves the value", () => {
        const env = new StringEnvMap()
        env.setValue("K", "v")
        assert.strictEqual(env.getValue("K"), "v")
    })

    test("setValue overwrites an existing value", () => {
        const env = new StringEnvMap({ K: "old" })
        env.setValue("K", "new")
        assert.strictEqual(env.getValue("K"), "new")
    })
})

suite("StringEnvMap.getTrimmedValue", () => {
    test("returns the trimmed value for an existing key", () => {
        const env = new StringEnvMap({ K: "  hello  " })
        assert.strictEqual(env.getTrimmedValue("K"), "hello")
    })

    test("returns undefined for a missing key", () => {
        assert.strictEqual(new StringEnvMap().getTrimmedValue("X"), undefined)
    })

    test("returns empty string when the value is blank after trimming", () => {
        assert.strictEqual(new StringEnvMap({ K: "   " }).getTrimmedValue("K"), "")
    })

    test("returns empty string when the value is empty string", () => {
        assert.strictEqual(new StringEnvMap({ K: "" }).getTrimmedValue("K"), "")
    })
})

suite("StringEnvMap.filter", () => {
    test("returns entries matching the predicate", () => {
        const env = new StringEnvMap({ A: "1", B: "2", C: "3" })
        const result = env.filter((_k, v) => v !== "2")
        assert.deepStrictEqual(result.toRecord(), { A: "1", C: "3" })
    })

    test("returns an empty map when nothing matches", () => {
        const env = new StringEnvMap({ A: "x" })
        assert.strictEqual(env.filter(() => false).size, 0)
    })

    test("does not mutate the original map", () => {
        const env = new StringEnvMap({ A: "x", B: "y" })
        env.filter((_k, v) => v === "x")
        assert.strictEqual(env.size, 2)
    })

    test("predicate receives both key and value", () => {
        const env = new StringEnvMap({ PREFIX_A: "1", B: "2" })
        const result = env.filter((k) => k.startsWith("PREFIX_"))
        assert.deepStrictEqual(result.toRecord(), { PREFIX_A: "1" })
    })
})

suite("StringEnvMap.addAll", () => {
    test("copies all entries from other into this", () => {
        const a = new StringEnvMap({ X: "1" })
        const b = new StringEnvMap({ Y: "2" })
        a.addAll(b)
        assert.deepStrictEqual(a.toRecord(), { X: "1", Y: "2" })
    })

    test("later values win for duplicate keys", () => {
        const a = new StringEnvMap({ K: "old" })
        const b = new StringEnvMap({ K: "new" })
        a.addAll(b)
        assert.strictEqual(a.getValue("K"), "new")
    })

    test("does not mutate other", () => {
        const a = new StringEnvMap()
        const b = new StringEnvMap({ K: "v" })
        a.addAll(b)
        assert.strictEqual(b.size, 1)
    })
})

suite("StringEnvMap.deleteKey", () => {
    test("removes an existing key", () => {
        const env = new StringEnvMap({ A: "x", B: "y" })
        env.deleteKey("A")
        assert.deepStrictEqual(env.toRecord(), { B: "y" })
    })

    test("is a no-op for a missing key", () => {
        const env = new StringEnvMap({ A: "x" })
        env.deleteKey("MISSING")
        assert.deepStrictEqual(env.toRecord(), { A: "x" })
    })
})

suite("StringEnvMap.deleteIf", () => {
    test("removes entries matching the predicate in place", () => {
        const env = new StringEnvMap({ A: "keep", SECRET_RESOLVER_X: "drop" })
        env.deleteIf((k) => k.startsWith("SECRET_RESOLVER_"))
        assert.deepStrictEqual(env.toRecord(), { A: "keep" })
    })

    test("removes nothing when predicate never matches", () => {
        const env = new StringEnvMap({ A: "x", B: "y" })
        env.deleteIf(() => false)
        assert.strictEqual(env.size, 2)
    })

    test("can remove all entries", () => {
        const env = new StringEnvMap({ A: "x", B: "y" })
        env.deleteIf(() => true)
        assert.strictEqual(env.size, 0)
    })
})

suite("StringEnvMap.toRecord", () => {
    test("produces a plain object with all entries", () => {
        const env = new StringEnvMap({ A: "1", B: "2" })
        assert.deepStrictEqual(env.toRecord(), { A: "1", B: "2" })
    })

    test("produces an empty object for an empty map", () => {
        assert.deepStrictEqual(new StringEnvMap().toRecord(), {})
    })

    test("does not mutate the map when the record is modified", () => {
        const env = new StringEnvMap({ A: "1" })
        const rec = env.toRecord()
        rec["A"] = "changed"
        assert.strictEqual(env.getValue("A"), "1")
    })
})
