/**
 * Ordered string-to-string env map used throughout the resolver. Encapsulates
 * the underlying `Map`; callers use the query/update methods instead of
 * reaching into the entries directly.
 */
export class StringEnvMap {
    private readonly entries: Map<string, string>

    constructor(initial: Record<string, string | null | undefined> = {}) {
        this.entries = new Map()

        for (const [key, value] of Object.entries(initial)) {
            if (typeof value === "string") {
                this.entries.set(key, value)
            }
        }
    }

    get size(): number {
        const count = this.entries.size
        return count
    }

    setValue(key: string, value: string): void {
        this.entries.set(key, value)
    }

    getValue(key: string): string | undefined {
        const value = this.entries.get(key)
        return value
    }

    hasKey(key: string): boolean {
        const exists = this.entries.has(key)
        return exists
    }

    getTrimmedValue(key: string): string | undefined {
        const value = this.entries.get(key)

        if (value === undefined) {
            return undefined
        }

        const trimmed = value.trim()
        return trimmed
    }

    /**
     * Returns a new map holding only the entries matching `predicate`.
     */
    filter(predicate: (key: string, value: string) => boolean): StringEnvMap {
        const filtered = new StringEnvMap()

        for (const [key, value] of this.entries) {
            if (predicate(key, value)) {
                filtered.entries.set(key, value)
            }
        }

        return filtered
    }

    /**
     * True when at least one entry matches `predicate`.
     */
    some(predicate: (key: string, value: string) => boolean): boolean {
        for (const [key, value] of this.entries) {
            if (predicate(key, value)) {
                return true
            }
        }

        return false
    }

    forEach(callback: (key: string, value: string) => void): void {
        for (const [key, value] of this.entries) {
            callback(key, value)
        }
    }

    /**
     * Returns the values as an array, in insertion order.
     */
    valueList(): string[] {
        const values = [...this.entries.values()]
        return values
    }

    /**
     * Merges `other` into this map; entries from `other` win on key clashes.
     */
    addAll(other: StringEnvMap): void {
        for (const [key, value] of other.entries) {
            this.entries.set(key, value)
        }
    }

    deleteKey(key: string): void {
        this.entries.delete(key)
    }

    deleteIf(predicate: (key: string, value: string) => boolean): void {
        for (const [key, value] of this.entries) {
            if (predicate(key, value)) {
                this.entries.delete(key)
            }
        }
    }

    toRecord(): Record<string, string> {
        const out: Record<string, string> = {}

        for (const [key, value] of this.entries) {
            out[key] = value
        }

        return out
    }
}
