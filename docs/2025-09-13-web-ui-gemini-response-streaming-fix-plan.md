# Gemini Web UI Response Streaming Fix Implementation Plan

## Issue Overview

**Title:** WebUiGeminiHandler Fails to Parse Malformed Google `wrb.fr` Data Stream

**Summary:**
The `parseGoogleStream` function in `WebUiGeminiHandler` was unable to correctly parse the Gemini streaming response. The stream's length-prefixes were unreliable and the JSON chunks were malformed, containing illegal newlines and extraneous characters. This caused consistent JSON parsing failures, preventing the extraction of any meaningful content from the stream.

## Root Cause Analysis

**Primary Issue:** Unreliable Stream Metadata and Malformed JSON

The root cause was twofold:

1.  **Unreliable Length-Prefixing:** The stream's length prefixes (e.g., `216 [...]`) were incorrect and did not correspond to the actual boundaries of valid JSON objects. Slicing the stream based on these lengths resulted in fragmented, unparsable chunks.
2.  **Malformed JSON Chunks:** The data contained illegal characters within string literals (such as unescaped newlines), which violates the JSON specification and causes `JSON.parse()` to fail.

Initial attempts to sanitize the incorrectly sliced chunks were unsuccessful because the fundamental problem—the faulty slicing strategy—was not addressed. The length-prefixing approach was deemed fundamentally unreliable for this data stream.

## Selected Approach

**Chosen Solution:** Structural Parsing with a Bracket-Matching Algorithm

Given the unreliable nature of the stream's metadata, the selected solution was to completely abandon the length-prefixing strategy. A new, more robust approach was implemented that parses the stream based on the universal structure of JSON.

**Justification:**

1.  **Robustness:** This method is immune to incorrect length prefixes and garbage data between JSON objects. It relies only on the structural integrity of the JSON itself.
2.  **Accuracy:** By finding the precise start (`[`) and end (`]`) of each JSON object while respecting string literal boundaries, it guarantees that only complete, well-formed data is sent to `JSON.parse()`, eliminating parsing errors.
3.  **Simplicity:** The new logic is a self-contained, focused algorithm that replaces the complex and fragile process of slicing and sanitizing.
4.  **Low Risk:** The change is isolated to the `parseGoogleStream` function and has no external dependencies.

## Implementation Plan

### Final Implementation Steps

The implementation was revised to focus on a single, critical phase: replacing the parser.

1.  **Remove Length-Based Parsing:** The entire `while` loop that relied on `headerPattern` and `chunkLength` was deleted.
2.  **Implement Bracket-Matching Parser:**
    - A new `while` loop was created to iterate through the stream using a cursor.
    - The logic finds the index of the next opening bracket `[`.
    - From there, it iterates character by character, maintaining a `balance` counter (`++` for `[` and `--` for `]`).
    - The logic correctly handles brackets inside string literals by tracking an `inString` state, preventing them from affecting the balance.
    - When the `balance` returns to zero, a complete JSON object has been found.
3.  **Extract and Parse:** The substring for the complete JSON object is sliced out and parsed.
4.  **Integrate XML Validation:** The existing `detectUnalignedXml` function remains a crucial part of the `createMessage` flow. After the `parseGoogleStream` function successfully returns content, `detectUnalignedXml` inspects it to ensure that any tool calls (like `<list_files>`) are structurally sound. If the XML is malformed, it triggers a regeneration request.
5.  **Update Test Suite:** The corresponding test file (`web-ui-gemini-streaming.spec.ts`) was updated to assert against the correct output now being produced by the new parser.
6.  **Code Cleanup:** An unused helper function, `xmlUnescapeConditional`, was removed.

### Code Examples

#### Final Parsing Logic in `parseGoogleStream`

```typescript
export function parseGoogleStream(rawData: string): string {
	const enableLogging = true
	const log = (message: string, ...args: any[]) => {
		if (enableLogging) console.log(`[Parser Debug] ${message}`, ...args)
	}

	log("Starting stream parsing with new bracket-matching logic...")

	const stream = rawData
	const finalContent: FinalContent = { narrative: null, codeBlock: null }
	let cursor = 0
	let chunkCount = 0

	while (cursor < stream.length) {
		const firstBracket = stream.indexOf("[", cursor)
		if (firstBracket === -1) {
			log("No more opening brackets found. Ending parse.")
			break
		}

		let balance = 0
		let inString = false
		let i = firstBracket
		let lastValidBracket = -1

		for (; i < stream.length; i++) {
			const char = stream[i]
			if (inString) {
				if (char === "\\") {
					i++ // Skip next character, it's escaped
				} else if (char === '"') {
					inString = false
				}
			} else {
				if (char === '"') {
					inString = true
				} else if (char === "[") {
					balance++
				} else if (char === "]") {
					balance--
				}
			}
			if (balance === 0 && firstBracket !== i) {
				lastValidBracket = i
				break // Found a complete JSON object/array
			}
		}

		if (lastValidBracket !== -1) {
			chunkCount++
			const chunkData = stream.substring(firstBracket, lastValidBracket + 1)
			cursor = lastValidBracket + 1
		} else {
			log(`Could not find a matching closing bracket for the one at index ${firstBracket}. Ending parse.`)
			break // No matching bracket found, end of stream
		}
	}
}
```

#### Role of `detectUnalignedXml`

```typescript
// Located in createMessage method
const parsed = parseGoogleStream(completeResponse)

if (parsed) {
	if (this.malformedTokenList.some((token) => parsed.includes(token)) || detectUnalignedXml(parsed)) {
		// Triggers regeneration if XML is not well-formed
		reject(new RegenerationError("Malformed token or unaligned XML found..."))
	} else {
		resolve(parsed)
	}
}
```
