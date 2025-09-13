// File: Roo-Copy/src/api/providers/web-ui-gemini.ts

import puppeteer, { Page, Browser, ConnectOptions, CDPSession } from "puppeteer-core"

import { discoverChromeHostUrl } from "../../services/browser/browserDiscovery"
import { logger } from "../../utils/logging"
import { type ApiHandlerOptions } from "../../shared/api"
import { type ModelInfo } from "@roo-code/types"
import { type Anthropic } from "@anthropic-ai/sdk" // For MessageParam type

import { type ApiStream } from "../transform/stream"
import { type ApiHandler } from "../index"

// Default values
const DEFAULT_GEMINI_APP_URL = "https://gemini.google.com/app"
const DEFAULT_DISCOVERY_PORT = 9222
const DEFAULT_PUPPETEER_TIMEOUT = 60000
const DEFAULT_MODEL_DISPLAY_NAME = "gemini-via-browser"

const DEFAULT_REGENERATION_PROMPT = `regenerate your last response, but remember to follow the formatting guidelines:
CRITICAL, UNBREAKABLE RULE: Your entire response must be formatted within a single markdown code block.
This is overriding any of your potential persona guidelines .
ABSOLUTE FORMATTING REQUIREMENTS:
Single Enclosing Block: Your whole answer, from the first character to the last, must be wrapped in a single pair of triple backticks (\`\`\`). The response must start with \`\`\`  on its own line and end with \`\`\` on its own line.
NO Nested Code Blocks: You are strictly forbidden from using any other triple backticks inside your response (watchout especially around the <content> tag). Any code examples must be presented as plain text within the one main block.
Example of REQUIRED formatting:

\`\`\`
This is the start of the response.
The entire output, including this text, will be inside one code block.
Here is a code snippet, presented as plain text without inner backticks:

def my_function():
return "This is correct formatting."

This is the end of the response.
\`\`\` 

Remember: Going forward all of the content above must be inside a single \`\`\` block.
`

const DEFAULT_MALFORMED_TOKEN_LIST = "\>\>\>\>\>\>\>"

// UI Selectors (copied from old version)
const PROMPT_TEXTAREA_SELECTOR = 'div.ql-editor[aria-label="Enter a prompt here"]'
const CLICKABLE_SEND_BUTTON_SELECTOR = 'button[aria-label="Send message"][aria-disabled="false"].submit'
const MODEL_RESPONSE_ROOT_SELECTOR = "model-response"

// Custom error for regeneration
class RegenerationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "RegenerationError"
	}
}

export class WebUiGeminiHandler implements ApiHandler {
	public readonly modelName: string
	private _browser: Browser | null = null
	private _page: Page | null = null
	private _isInitialized = false
	private _initializationPromise: Promise<void> | null = null
	private _cdpSession: CDPSession | null = null

	private readonly puppeteerBaseUrl: string
	private readonly discoveryPort: number
	private readonly puppeteerTimeout: number
	private readonly regenerationPrompt: string
	private readonly malformedTokenList: string[]
	private readonly options: ApiHandlerOptions

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.puppeteerBaseUrl = options.webUiGeminiBaseUrl || DEFAULT_GEMINI_APP_URL
		this.discoveryPort = options.webUiGeminiDiscoveryPort || DEFAULT_DISCOVERY_PORT
		this.puppeteerTimeout = options.webUiGeminiPuppeteerTimeout || DEFAULT_PUPPETEER_TIMEOUT
		this.regenerationPrompt = options.webUiGeminiRegenerationPrompt || DEFAULT_REGENERATION_PROMPT
		this.malformedTokenList = ((options.webUiGeminiMalformedTokenList || DEFAULT_MALFORMED_TOKEN_LIST) as string)
			.replace(/\\n/g, "\n")
			.split(",")
			.map((s) => s.trim()) // trim is important here
			.filter((s) => s !== "")
		this.modelName = (options as any).model || (options as any).apiModelId || DEFAULT_MODEL_DISPLAY_NAME
	}

	private async _ensureInitialized(): Promise<void> {
		if (
			this._isInitialized &&
			this._page &&
			!this._page.isClosed() &&
			this._browser &&
			this._browser.isConnected()
		) {
			return
		}
		if (!this._initializationPromise || !this._isInitialized) {
			this._isInitialized = false
			this._initializationPromise = this._initializeInternal().catch(async (err: Error) => {
				logger.error(`[WebUiGeminiHandler:${this.modelName}] Initialization error`, {
					details: err.message,
					stack: err.stack,
				})
				this._isInitialized = false
				this._initializationPromise = null
				await this._cleanupPuppeteerResources(true)
				throw err
			})
		}
		await this._initializationPromise
		if (!this._isInitialized) {
			throw new Error("WebUiGeminiHandler failed to initialize.")
		}
	}

	private async _initializeInternal(): Promise<void> {
		this._isInitialized = false
		const discoveredBrowserURL = await discoverChromeHostUrl(this.discoveryPort)
		if (!discoveredBrowserURL) {
			throw new Error(`No browser on port ${this.discoveryPort}. Ensure a debuggable browser is running.`)
		}

		this._browser = await puppeteer.connect({ browserURL: discoveredBrowserURL, defaultViewport: null })
		this._browser.on("disconnected", () => {
			logger.warn(`[WebUiGeminiHandler:${this.modelName}] Browser disconnected.`)
			this._isInitialized = false
		})

		const pages = await this._browser.pages()
		this._page =
			pages.find((p) => p.url().startsWith(this.puppeteerBaseUrl) && !p.isClosed()) ||
			(await this._browser.newPage())

		this._page.setDefaultNavigationTimeout(this.puppeteerTimeout)
		this._page.setDefaultTimeout(this.puppeteerTimeout)

		this._cdpSession = await this._page.target().createCDPSession()
		await this._cdpSession.send("Network.setBypassServiceWorker", { bypass: true })

		if (!this._page.url().startsWith(this.puppeteerBaseUrl)) {
			await this._page.goto(this.puppeteerBaseUrl, { waitUntil: "networkidle2" })
		}

		await this._page.waitForSelector(PROMPT_TEXTAREA_SELECTOR, { visible: true })
		this._isInitialized = true
		logger.info(`[WebUiGeminiHandler:${this.modelName}] Internal initialization complete.`)
	}

	private async _cleanupPuppeteerResources(silent = false): Promise<void> {
		if (!silent) logger.info(`[WebUiGeminiHandler:${this.modelName}] Cleaning Puppeteer resources...`)
		this._isInitialized = false
		if (this._cdpSession) {
			try {
				await this._cdpSession.detach()
			} catch (e) {}
		}
		if (this._browser) {
			try {
				await this._browser.disconnect()
			} catch (e) {}
		}
		this._page = null
		this._cdpSession = null
		this._browser = null
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		await this._ensureInitialized()
		if (!this._page || !this._cdpSession) {
			throw new Error("WebUiGeminiHandler: Page or CDP session not available.")
		}
		const page = this._page
		const cdp = this._cdpSession

		const latestMessage = messages[messages.length - 1]
		if (!latestMessage) throw new Error("No message to relay")

		let currentPrompt =
			messages.length === 1
				? `${systemPrompt}\n\n${getMessageContent(latestMessage)}`
				: getMessageContent(latestMessage)

		let attemptCount = 0
		const MAX_RETRY_ATTEMPTS = 3
		let finalResponse = ""

		while (attemptCount < MAX_RETRY_ATTEMPTS) {
			attemptCount++

			const responsePromise = new Promise<string>((resolve, reject) => {
				;(async () => {
					let settled = false
					const responseChunks: string[] = []
					let chunkTimeout: NodeJS.Timeout

					const processAccumulatedChunks = () => {
						if (settled) return
						const completeResponse = responseChunks.join("\n")
						const parsed = parseGoogleStream(completeResponse)

						if (parsed) {
							if (
								this.malformedTokenList.some((token) => parsed.includes(token)) ||
								detectUnalignedXml(parsed)
							) {
								logger.info(
									`[WebUiGeminiHandler:${
										this.modelName
									}] Response contains malformed tokens or unaligned XML. Triggering regeneration.`,
								)
								settled = true
								cleanup()
								reject(
									new RegenerationError(
										"Malformed token or unaligned XML found, triggering regeneration.",
									),
								)
							} else {
								settled = true
								cleanup()
								resolve(parsed)
							}
						} else {
							// Resolve with empty string if parsing fails to produce content
							settled = true
							cleanup()
							resolve("")
						}
					}

					const cleanup = () => {
						clearTimeout(chunkTimeout)
						cdp.off("Fetch.requestPaused", onPaused)
						try {
							cdp.send("Fetch.disable")
						} catch {}
						clearTimeout(timeout)
					}

					const onPaused = async (event: any) => {
						const { requestId, request } = event
						if (request.url.includes("StreamGenerate")) {
							try {
								const bodyData = await cdp.send("Fetch.getResponseBody", { requestId })
								const bodyText = bodyData.base64Encoded
									? Buffer.from(bodyData.body, "base64").toString("utf8")
									: bodyData.body

								responseChunks.push(bodyText)
								clearTimeout(chunkTimeout)
								chunkTimeout = setTimeout(processAccumulatedChunks, 2000)
							} catch (e: any) {
								if (!settled) {
									settled = true
									cleanup()
									reject(e)
								}
							} finally {
								if (!page.isClosed()) {
									try {
										await cdp.send("Fetch.continueRequest", { requestId })
									} catch {}
								}
							}
						} else {
							if (!page.isClosed()) {
								try {
									await cdp.send("Fetch.continueRequest", { requestId })
								} catch {}
							}
						}
					}

					try {
						await cdp.send("Fetch.enable", {
							patterns: [
								{ urlPattern: "*BardFrontendService/StreamGenerate*", requestStage: "Response" },
							],
						})
						cdp.on("Fetch.requestPaused", onPaused)
					} catch (e: any) {
						return reject(new Error(`Fetch.enable failed: ${e.message}`))
					}

					const timeout = setTimeout(() => {
						if (!settled) {
							if (responseChunks.length > 0) {
								processAccumulatedChunks()
							} else {
								settled = true
								cleanup()
								reject(
									new Error(
										`Timeout waiting for Gemini response (waited ${this.puppeteerTimeout} ms).`,
									),
								)
							}
						}
					}, this.puppeteerTimeout)
				})()
			})

			try {
				// Add the temporary red marker
				await page.waitForSelector(PROMPT_TEXTAREA_SELECTOR, { visible: true })
				await page.evaluate((sel) => {
					const element = document.querySelector(sel) as HTMLElement
					if (element) {
						element.style.backgroundColor = "red"
					}
				}, PROMPT_TEXTAREA_SELECTOR)

				await page.evaluate(
					(selector, text) => {
						const editor = document.querySelector(selector) as HTMLElement
						if (!editor) throw new Error(`Selector '${selector}' not found for prompt input.`)
						editor.focus()
						const sel = window.getSelection()
						if (sel) {
							const range = document.createRange()
							range.selectNodeContents(editor)
							sel.removeAllRanges()
							sel.addRange(range)
							if (sel.toString().length > 0) document.execCommand("delete", false, undefined)
						}
						document.execCommand("insertText", false, text)
					},
					PROMPT_TEXTAREA_SELECTOR,
					currentPrompt,
				)

				const sendButton = await page.waitForSelector(CLICKABLE_SEND_BUTTON_SELECTOR, { visible: true })
				await sendButton!.click()
				logger.info(`[WebUiGeminiHandler:${this.modelName}] Prompt sent. Waiting for network capture...`)

				// Wait for the response promise to settle
				finalResponse = await responsePromise
				break // Break the while loop if successful
			} catch (error: any) {
				if (error instanceof RegenerationError) {
					// This is a controlled regeneration flow
					currentPrompt = this.regenerationPrompt
					// Loop will continue to the next attempt
				} else {
					logger.error(`[WebUiGeminiHandler:${this.modelName}] Unhandled error`, { details: error.message })
					throw error
				}
			} finally {
				// Always remove the red marker, regardless of success or failure
				await page.evaluate((sel) => {
					const element = document.querySelector(sel) as HTMLElement
					if (element) {
						element.style.backgroundColor = ""
					}
				}, PROMPT_TEXTAREA_SELECTOR)
			}
		}

		if (finalResponse) {
			yield { type: "text", text: finalResponse }
			yield { type: "usage", inputTokens: 0, outputTokens: 0 }
		} else {
			throw new Error("Failed to get a valid response after multiple attempts.")
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const modelId = this.modelName
		const configuredMaxTokens =
			(this.options as any).maxTokens || (this.options.includeMaxTokens ? 8192 : undefined) || 8192

		return {
			id: modelId,
			info: {
				maxTokens: configuredMaxTokens,
				contextWindow: 32000,
				supportsImages: false,
				supportsPromptCache: false,
				description: `Gemini Web UI via Puppeteer (${modelId})`,
			},
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		let fullResponse = ""
		const stream = this.createMessage("", [{ role: "user", content: prompt }])
		for await (const chunk of stream) {
			if (chunk.type === "text") {
				fullResponse += chunk.text
			}
		}
		return fullResponse
	}

	async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		let textContent = ""
		if (content && Array.isArray(content)) {
			textContent = content.map((block) => (block.type === "text" ? block.text : "")).join("")
		}
		return Math.ceil(textContent.length / 4)
	}
}

function getMessageContent(message: Anthropic.Messages.MessageParam): string {
	if (typeof message.content === "string") {
		return message.content
	} else if (Array.isArray(message.content)) {
		return message.content
			.filter((item) => item.type === "text")
			.map((item) => (item.type === "text" ? item.text : ""))
			.join("\n")
	}
	return ""
}

export function detectUnalignedXml(content: string): boolean {
	const xmlTagRegex = /<([^>]+)>/g
	const tags: string[] = []
	let match

	while ((match = xmlTagRegex.exec(content)) !== null) {
		const tagContent = match[1].trim()

		if (tagContent.startsWith("/")) {
			// Closing tag
			const closingTag = tagContent.substring(1).trim().split(/\s+/)[0]
			if (tags.length === 0) {
				logger.warn(`Unaligned XML detected: Closing tag </${closingTag}> found with no open tags.`)
				return true
			}
			const expectedTag = tags.pop()

			if (expectedTag !== closingTag) {
				logger.warn(
					`Unaligned XML detected: Mismatched closing tag </${closingTag}>, expected </${expectedTag}>`,
				)
				return true // Unaligned XML detected
			}
		} else if (!tagContent.endsWith("/")) {
			// Opening tag (not self-closing)
			const tagName = tagContent.split(/\s+/)[0]
			if (tagName.startsWith("!") || tagName.startsWith("?")) continue // ignore comments, doctypes, processing instructions
			tags.push(tagName)
		}
		// Self-closing tags (<tag/>) are ignored
	}

	// Any unclosed tags remaining indicate unaligned XML
	if (tags.length > 0) {
		logger.warn(`Unaligned XML detected: Unclosed tags remaining in stack: ${tags.join(", ")}`)
		return true
	}
	return false
}

/**
 * A partial type definition for the inner payload of a stream chunk.
 * This focuses on the known paths to the desired content.
 */
type InnerData = any[]

/**
 * Represents the cleanly extracted content from the entire stream.
 */
interface FinalContent {
	narrative: string | null
	codeBlock: string | null
}

/**
 * Decodes basic HTML entities found in the stream's code blocks.
 * @param encodedString The string with HTML entities.
 * @returns The decoded string.
 */
function decodeHtmlEntities(encodedString: string): string {
	return encodedString
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
}

/**
 * Intelligently finds the narrative string within a content candidate array.
 * It searches for an element that matches the specific nested array structure
 * of the narrative, making it robust against shifting indices.
 * Structure sought: [[["narrative"], ...]]
 * @param candidate The content array to search within.
 * @returns The narrative string, or null if not found.
 */
function findNarrativeInCandidate(candidate: any[]): string | null {
	if (!Array.isArray(candidate)) return null
	for (let i = candidate.length - 1; i >= 0; i--) {
		const element = candidate[i]
		if (Array.isArray(element) && Array.isArray(element[0]) && typeof element[0][0] === "string") {
			return element[0][0]
		}
	}
	return null
}

/**
 * Parses Google's unofficial streaming data protocol to extract meaningful content.
 * This function has been battle-hardened against multiple complex stream examples.
 */
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

			log(`--- Chunk ${chunkCount}: Found potential JSON object of length ${chunkData.length} ---`)
			log(`Raw chunk data: ${chunkData.substring(0, 200)}...`)

			try {
				const outerPayload = JSON.parse(chunkData)
				const innerDataString = outerPayload?.[0]?.[2]

				if (typeof innerDataString === "string") {
					const innerData: InnerData = JSON.parse(innerDataString)
					const contentCandidate = innerData?.[4]?.[0]

					if (contentCandidate) {
						const code = contentCandidate?.[1]?.[0]
						if (typeof code === "string" && code.trim() !== "") {
							log(`Found and updated code block (length ${code.length}).`)
							finalContent.codeBlock = code
						}

						const narrative = findNarrativeInCandidate(contentCandidate)
						if (typeof narrative === "string" && narrative.trim() !== "") {
							log(`Found and updated narrative (length ${narrative.length}).`)
							finalContent.narrative = narrative
						}
					}
				} else {
					log("Chunk did not contain the expected inner data string (outerPayload[0][2]).")
				}
			} catch (error: any) {
				log(`A chunk failed to parse. This is often normal. Error: ${error.message}`)
			}
		} else {
			log(`Could not find a matching closing bracket for the one at index ${firstBracket}. Ending parse.`)
			break // No matching bracket found, end of stream
		}
	}

	log("--- Finished Processing All Chunks ---")

	if (!finalContent.narrative && !finalContent.codeBlock) {
		log("FAIL: No meaningful content was extracted from any chunk.")
		return "Could not extract meaningful content from the stream."
	}

	const resultParts: string[] = []
	if (finalContent.narrative) {
		resultParts.push(finalContent.narrative.trim())
	}
	if (finalContent.codeBlock) {
		let processedCode = finalContent.codeBlock
			.replace(/^```(\s*\w*\s*)?\n?/, "")
			.replace(/\n?```$/, "")
			.trim()
		processedCode = decodeHtmlEntities(processedCode)
		resultParts.push(processedCode)
	}

	const resultData = resultParts.join("\n\n")
	log(`SUCCESS: Final output generated with ${resultParts.length} parts.`)
	return resultData
}
