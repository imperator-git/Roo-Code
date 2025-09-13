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
		it("should return false for properly aligned tool XML", () => {
			const validXml = `<update_todo_list><todos>[-] Check what's missing from the fridge</todos></update_todo_list>`
			expect(detectUnalignedXml(validXml)).toBe(false)
		})

		it("should return false for self-closing non-tool tags (ignored)", () => {
			const selfClosingXml = `<tag/><another-tag attr="value"/>`
			expect(detectUnalignedXml(selfClosingXml)).toBe(false)
		})

		it("should return false for non-tool tags with attributes (ignored)", () => {
			const xmlWithAttrs = `<div class="container"><span id="text">Content</span></div>`
			expect(detectUnalignedXml(xmlWithAttrs)).toBe(false)
		})

		it("should return false for unclosed non-tool tags (ignored)", () => {
			const unclosedXml = `<div><span>Content</div>` // Missing </span>
			expect(detectUnalignedXml(unclosedXml)).toBe(false)
		})

		it("should return false for mismatched non-tool closing tags (ignored)", () => {
			const mismatchedXml = `<div></span>` // Wrong closing tag
			expect(detectUnalignedXml(mismatchedXml)).toBe(false)
		})

		it("should return false for nested unclosed non-tool tags (ignored)", () => {
			const nestedUnclosed = `<div><span><em>Text</em></span>` // Missing </div>
			expect(detectUnalignedXml(nestedUnclosed)).toBe(false)
		})

		it("should return false for complex non-tool XML structures (ignored)", () => {
			const complexXml = `<root>
				<container>
					<item status="pending">Check what's missing</item>
					<item status="in-progress">Make shopping list</item>
				</container>
			</root>`
			expect(detectUnalignedXml(complexXml)).toBe(false)
		})

		it("should return false for mixed content with non-tool XML (ignored)", () => {
			const mixedContent = `Some text before <div attr="value">content</div> and after`
			expect(detectUnalignedXml(mixedContent)).toBe(false)
		})

		it("should detect unaligned tool XML in sample response", () => {
			const malformedResponse = `**Response**

Some text <update_todo_list><todos>[-] Item 1</todos> and more text`
			expect(detectUnalignedXml(malformedResponse)).toBe(true)
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Unaligned XML detected"))
		})

		it("should validate complete sample response", () => {
			expect(detectUnalignedXml(sampleCompleteResponse)).toBe(false)
		})

		it("should detect unclosed tool tags", () => {
			const unclosedToolXml = `<read_file><path>src/main.ts</path> and some text`
			expect(detectUnalignedXml(unclosedToolXml)).toBe(true)
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Unaligned XML detected"))
		})

		it("should detect mismatched tool closing tags", () => {
			const mismatchedToolXml = `<read_file></search_files>`
			expect(detectUnalignedXml(mismatchedToolXml)).toBe(true)
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Unaligned XML detected"))
		})

		it("should handle properly nested tool tags", () => {
			const nestedToolXml = `<update_todo_list>
				<todos>
					[-] First item
					[x] Second item
				</todos>
			</update_todo_list>`
			expect(detectUnalignedXml(nestedToolXml)).toBe(false)
		})

		it("should ignore self-closing tool tags", () => {
			const selfClosingToolXml = `<execute_command command="ls -la"/><read_file path="."/>`
			expect(detectUnalignedXml(selfClosingToolXml)).toBe(false)
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

		it("should detect unclosed tool tags", () => {
			const unclosedTool = "<read_file> content without closing tag"
			expect(detectUnalignedXml(unclosedTool)).toBe(true)
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Unaligned XML detected"))
		})

		it("should handle nested quotes in tool tag attributes", () => {
			const withQuotes = `<read_file path="file with 'quotes'.ts">content</read_file>`
			expect(detectUnalignedXml(withQuotes)).toBe(false)
		})

		it("should ignore malformed non-tool tag syntax", () => {
			const malformed = "<unclosed <div> content"
			expect(detectUnalignedXml(malformed)).toBe(false)
		})

		it("should ignore nested quotes in non-tool tag attributes", () => {
			const withQuotes = `<div attr="value with 'quotes'">content</div>`
			expect(detectUnalignedXml(withQuotes)).toBe(false)
		})
	})
})
