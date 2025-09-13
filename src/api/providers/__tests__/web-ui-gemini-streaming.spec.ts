import { vi, describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { logger } from "../../../utils/logging"

// Mock the logger
vi.mock("../../../utils/logging")

// Import functions to test after mocking
import { detectUnalignedXml, parseGoogleStream } from "../web-ui-gemini"

// Load test data from external file to avoid escaping issues
const sampleCompleteResponse = readFileSync(__dirname + "/sample-gemini-response.txt", "utf8")

describe("WebUiGeminiHandler Streaming Fix", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("XML Validation - detectUnalignedXml", () => {
		it("should return false for properly aligned XML", () => {
			const validXml = `<update_todo_list><todos>[-] Check what's missing from the fridge</todos></update_todo_list>`
			expect(detectUnalignedXml(validXml)).toBe(false)
		})

		it("should return false for self-closing tags", () => {
			const selfClosingXml = `<tag/><another-tag attr="value"/>`
			expect(detectUnalignedXml(selfClosingXml)).toBe(false)
		})

		it("should return false for tags with attributes", () => {
			const xmlWithAttrs = `<div class="container"><span id="text">Content</span></div>`
			expect(detectUnalignedXml(xmlWithAttrs)).toBe(false)
		})

		it("should return true for unclosed tags", () => {
			const unclosedXml = `<div><span>Content</div>` // Missing </span>
			expect(detectUnalignedXml(unclosedXml)).toBe(true)
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Unaligned XML detected"))
		})

		it("should return true for mismatched closing tags", () => {
			const mismatchedXml = `<div></span>` // Wrong closing tag
			expect(detectUnalignedXml(mismatchedXml)).toBe(true)
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Unaligned XML detected"))
		})

		it("should return true for nested unclosed tags", () => {
			const nestedUnclosed = `<div><span><em>Text</em></span>` // Missing </div>
			expect(detectUnalignedXml(nestedUnclosed)).toBe(true)
		})

		it("should handle complex XML structures", () => {
			const complexXml = `<update_todo_list>
				<todos>
					<item status="pending">Check what's missing</item>
					<item status="in-progress">Make shopping list</item>
				</todos>
			</update_todo_list>`
			expect(detectUnalignedXml(complexXml)).toBe(false)
		})

		it("should handle XML mixed with text content", () => {
			const mixedContent = `Some text before <tag attr="value">content</tag> and after`
			expect(detectUnalignedXml(mixedContent)).toBe(false)
		})

		it("should detect unaligned XML in sample response", () => {
			const malformedResponse = `**Response**

Some text <update_todo_list><todos>[-] Item 1</todos> and more text`
			expect(detectUnalignedXml(malformedResponse)).toBe(true)
		})

		it("should validate complete sample response", () => {
			expect(detectUnalignedXml(sampleCompleteResponse)).toBe(false)
		})
	})

	describe("Edge Cases", () => {
		it("should handle empty content", () => {
			expect(detectUnalignedXml("")).toBe(false)
		})

		describe("parseFinalResponse", () => {
			it("should correctly parse the complete streaming response from the user-provided example", () => {
				console.log("Test: calling parseFinalResponse with streamingData length", sampleCompleteResponse.length)
				console.log("Test: sampleCompleteResponse starts with", sampleCompleteResponse.substring(0, 200))
				const expectedThoughts = `**Examining Sound Files**

I'm currently verifying the files within the \`sounds\` directory. Based on the file content information, I'm expecting to see \`click.mp3\` and \`win.mp3\`. I'm about to use the \`list_files\` tool to confirm these assumptions.`
				const expectedToolCode = `<list_files>
<path>sounds</path>
</list_files>`
				const result = parseGoogleStream(sampleCompleteResponse)
				console.log("Test: result from parseGoogleStream:", result)
				expect(result?.trim()).toContain(expectedThoughts.trim())
				expect(result?.trim()).toContain(expectedToolCode.trim())
			})
		})

		it("should handle content without XML", () => {
			const plainText = "This is just plain text without any XML tags"
			expect(detectUnalignedXml(plainText)).toBe(false)
		})

		it("should handle malformed tag syntax", () => {
			const malformed = "<unclosed <another> content"
			expect(detectUnalignedXml(malformed)).toBe(true)
		})

		it("should handle nested quotes in attributes", () => {
			const withQuotes = `<tag attr="value with 'quotes'">content</tag>`
			expect(detectUnalignedXml(withQuotes)).toBe(false)
		})
	})
})
