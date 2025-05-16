// File: Roo-Copy/src/api/providers/web-ui-gemini.ts

import puppeteer, { Page, Browser, ConnectOptions } from "puppeteer-core"

import { discoverChromeHostUrl } from "../../services/browser/browserDiscovery"
import { logger } from "../../utils/logging"
import { type ApiHandlerOptions, type ModelInfo } from "../../shared/api"
import { type Anthropic } from "@anthropic-ai/sdk" // For MessageParam type

import { type ApiStream } from "../transform/stream"
// Assuming ApiHandler is the primary interface from your factory/index.ts
// If it's SingleCompletionHandler, and that interface itself requires countTokens, this is still valid.
import { type ApiHandler } from "../index" // Adjust path as needed

// Default values
const DEFAULT_GEMINI_APP_URL = "https://gemini.google.com/app"
const DEFAULT_DISCOVERY_PORT = 9222
const DEFAULT_PUPPETEER_TIMEOUT = 60000
const DEFAULT_MODEL_DISPLAY_NAME = "gemini-via-browser"

// UI Selectors
const PROMPT_TEXTAREA_SELECTOR = 'div.ql-editor[aria-label="Enter a prompt here"]'
const CLICKABLE_SEND_BUTTON_SELECTOR = 'button[aria-label="Send message"][aria-disabled="false"].submit'
const PROCESSING_STOP_BUTTON_SELECTOR = 'button[aria-label="Stop response"].stop'
const READY_FOR_INPUT_SEND_BUTTON_SELECTOR = 'button[aria-label="Microphone"]'
const MODEL_RESPONSE_ROOT_SELECTOR = "model-response"
const RESPONSE_MARKDOWN_SELECTOR = ".markdown-main-panel"

function decodeXmlEntities(encodedString: string): string {
	if (!encodedString) return ""
	return encodedString
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
}

// If ApiHandler includes all methods of SingleCompletionHandler plus countTokens:
export class WebUiGeminiHandler implements ApiHandler {
	// Or SingleCompletionHandler if that's the one with countTokens
	public readonly modelName: string

	private _browser: Browser | null = null
	private _page: Page | null = null
	private _isInitialized = false
	private _initializationPromise: Promise<void> | null = null

	private readonly puppeteerBaseUrl: string
	private readonly discoveryPort: number
	private readonly puppeteerTimeout: number

	private readonly options: ApiHandlerOptions

	constructor(options: ApiHandlerOptions) {
		this.options = options

		this.puppeteerBaseUrl = options.webUiGeminiBaseUrl || DEFAULT_GEMINI_APP_URL
		this.discoveryPort = options.webUiGeminiDiscoveryPort || DEFAULT_DISCOVERY_PORT
		this.puppeteerTimeout = options.webUiGeminiPuppeteerTimeout || DEFAULT_PUPPETEER_TIMEOUT

		this.modelName = (options as any).model || (options as any).apiModelId || DEFAULT_MODEL_DISPLAY_NAME

		logger.info(
			`[WebUiGeminiHandler:${this.modelName}] Constructed. Config: ${JSON.stringify({
				baseUrl: this.puppeteerBaseUrl,
				modelName: this.modelName,
				discoveryPort: this.discoveryPort,
				puppeteerTimeout: this.puppeteerTimeout,
				temperature: options.modelTemperature,
			})}`,
		)
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
		logger.info(
			`[WebUiGeminiHandler:${this.modelName}] Internal init. Port: ${this.discoveryPort}, URL: ${this.puppeteerBaseUrl}`,
		)
		this._isInitialized = false

		const discoveredBrowserURL = await discoverChromeHostUrl(this.discoveryPort)
		if (!discoveredBrowserURL) {
			const errorMsg = `No browser on port ${this.discoveryPort}. Ensure a debuggable browser is running.`
			logger.error(`[WebUiGeminiHandler:${this.modelName}] ${errorMsg}`)
			throw new Error(errorMsg)
		}
		logger.info(
			`[WebUiGeminiHandler:${this.modelName}] Discovered browser at ${discoveredBrowserURL}. Connecting...`,
		)

		try {
			const connectOptions: ConnectOptions = {
				browserURL: discoveredBrowserURL,
				defaultViewport: null,
			}
			this._browser = await puppeteer.connect(connectOptions)
			logger.info(`[WebUiGeminiHandler:${this.modelName}] Connected to browser: ${await this._browser.version()}`)
			this._browser.on("disconnected", () => {
				logger.warn(`[WebUiGeminiHandler:${this.modelName}] Browser disconnected.`)
				this._isInitialized = false
				this._browser = null
				this._page = null
			})

			const pages = await this._browser.pages()
			this._page =
				pages.find((p) => p.url().startsWith(this.puppeteerBaseUrl) && !p.isClosed()) ||
				(await this._browser.newPage())

			this._page.setDefaultNavigationTimeout(this.puppeteerTimeout)
			this._page.setDefaultTimeout(this.puppeteerTimeout)

			if (!this._page.url().startsWith(this.puppeteerBaseUrl)) {
				logger.info(`[WebUiGeminiHandler:${this.modelName}] Navigating to ${this.puppeteerBaseUrl}`)
				await this._page.goto(this.puppeteerBaseUrl, { waitUntil: "networkidle2" })
			} else {
				logger.info(`[WebUiGeminiHandler:${this.modelName}] Page already at target URL: ${this._page.url()}`)
			}

			this._page.on("close", () => {
				logger.warn(`[WebUiGeminiHandler:${this.modelName}] Page closed.`)
				this._page = null
				this._isInitialized = false
			})
			this._page.on("error", (err: Error) => {
				logger.error(`[WebUiGeminiHandler:${this.modelName}] Page crashed`, {
					details: err.message,
					stack: err.stack,
				})
				this._page = null
				this._isInitialized = false
			})
			this._page.on("pageerror", (err: Error) => {
				logger.error(`[WebUiGeminiHandler:${this.modelName}] Unhandled page exception`, {
					details: err.message,
					stack: err.stack,
				})
			})

			await this._page.waitForSelector(PROMPT_TEXTAREA_SELECTOR, { visible: true })
			this._isInitialized = true
			logger.info(
				`[WebUiGeminiHandler:${this.modelName}] Internal initialization complete. Page ready at ${this._page.url()}`,
			)
		} catch (error: any) {
			await this._cleanupPuppeteerResources(true)
			const errorMsg = error?.message || "Unknown initialization error"
			logger.error(`[WebUiGeminiHandler:${this.modelName}] Error during _initializeInternal`, {
				details: errorMsg,
				stack: error?.stack,
				errorObj: error,
			})
			throw new Error(errorMsg, { cause: error })
		}
	}

	private async _cleanupPuppeteerResources(silent = false): Promise<void> {
		if (!silent) logger.info(`[WebUiGeminiHandler:${this.modelName}] Cleaning Puppeteer resources...`)
		this._isInitialized = false
		this._page = null
		if (this._browser && this._browser.isConnected()) {
			try {
				await this._browser.disconnect()
			} catch (e: any) {
				if (!silent)
					logger.error(`[WebUiGeminiHandler:${this.modelName}] Error disconnecting browser`, {
						details: e?.message,
						stack: e?.stack,
					})
			}
		}
		this._browser = null
		if (!silent) logger.info(`[WebUiGeminiHandler:${this.modelName}] Puppeteer resources cleanup finished.`)
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		await this._ensureInitialized()
		if (!this._page || this._page.isClosed()) {
			throw new Error("WebUiGeminiHandler: Page is not available for API call.")
		}
		const page = this._page

		let fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n` : ""
		fullPrompt += messages
			.map((m) => {
				let contentText = ""
				if (typeof m.content === "string") {
					contentText = m.content
				} else {
					contentText = m.content
						.map((block) => (block.type === "text" ? block.text : `[Unsupported ${block.type}]`))
						.join("")
				}
				return `${m.role}: ${contentText}`
			})
			.join("\n\n")
		fullPrompt = fullPrompt.trim()

		logger.info(`[WebUiGeminiHandler:${this.modelName}] Sending prompt. Timeout: ${this.puppeteerTimeout}ms.`)
		logger.debug(`[WebUiGeminiHandler:${this.modelName}] Prompt: "${fullPrompt.substring(0, 100)}..."`)

		try {
			await page.waitForSelector(PROMPT_TEXTAREA_SELECTOR, { visible: true })
			await page.focus(PROMPT_TEXTAREA_SELECTOR)

			const currentInitialResponseCount = await page.$$eval(MODEL_RESPONSE_ROOT_SELECTOR, (els) => els.length)

			await page.evaluate(
				(selector, text) => {
					const editor = document.querySelector(selector) as HTMLElement
					if (editor) {
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
					} else {
						throw new Error(`Selector '${selector}' not found for prompt input.`)
					}
				},
				PROMPT_TEXTAREA_SELECTOR,
				fullPrompt,
			)

			const sendButton = await page.waitForSelector(CLICKABLE_SEND_BUTTON_SELECTOR, { visible: true })
			await sendButton!.click()

			await page.waitForSelector(PROCESSING_STOP_BUTTON_SELECTOR, { visible: true })
			await page.waitForSelector(PROCESSING_STOP_BUTTON_SELECTOR, { hidden: true })
			await page
				.waitForSelector(READY_FOR_INPUT_SEND_BUTTON_SELECTOR, { visible: true })
				.catch(() =>
					logger.warn(
						`[WebUiGeminiHandler:${this.modelName}] Ready-for-input indicator did not reappear as expected.`,
					),
				)

			const waitSuccess = await page.waitForFunction(
				(sel, count, checkInterval, funcTimeout) => {
					return new Promise((resolve) => {
						const startTime = Date.now()
						const interval = setInterval(() => {
							if (document.querySelectorAll(sel).length > count) {
								clearInterval(interval)
								resolve(true)
							} else if (Date.now() - startTime > funcTimeout) {
								clearInterval(interval)
								resolve(false)
							}
						}, checkInterval)
					})
				},
				{ timeout: this.puppeteerTimeout },
				MODEL_RESPONSE_ROOT_SELECTOR,
				currentInitialResponseCount,
				100,
				this.puppeteerTimeout - 500,
			)

			if (!waitSuccess) {
				throw new Error("Timeout waiting for new model response to appear.")
			}

			const currentResponseRoots = await page.$$(MODEL_RESPONSE_ROOT_SELECTOR)
			if (currentInitialResponseCount >= currentResponseRoots.length)
				throw new Error("New model response not found after waitForFunction.")
			const newModelResponseElement = currentResponseRoots[currentInitialResponseCount]

			const newResponseMarkdownElement = await newModelResponseElement.$(RESPONSE_MARKDOWN_SELECTOR)
			if (!newResponseMarkdownElement) throw new Error("Markdown panel in new response not found.")

			const responseTextRaw = await newResponseMarkdownElement.evaluate((el) => (el as HTMLElement).innerText)
			const decodedResponseText = decodeXmlEntities(responseTextRaw).trim()

			yield { type: "text", text: decodedResponseText }
			yield { type: "usage", inputTokens: 0, outputTokens: 0 }
		} catch (error: any) {
			const errorMsg = error?.message || "Unknown Puppeteer interaction error"
			logger.error(`[WebUiGeminiHandler:${this.modelName}] Puppeteer interaction error`, {
				details: errorMsg,
				stack: error?.stack,
				errorObj: error,
			})
			if (this._page?.isClosed() || (this._browser && !this._browser.isConnected())) {
				this._isInitialized = false
				this._initializationPromise = null
			}
			throw new Error(errorMsg, { cause: error })
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const modelId = this.modelName
		const configuredMaxTokens =
			(this.options as any).maxTokens || (this.options.includeMaxTokens ? 8192 : undefined) || 8192

		const modelInfoFromSchema: ModelInfo = {
			maxTokens: configuredMaxTokens,
			contextWindow: 32000,
			supportsImages: false,
			supportsPromptCache: false,
			inputPrice: undefined,
			outputPrice: undefined,
			description: `Gemini Web UI via Puppeteer (${modelId})`,
			supportsComputerUse: false,
			thinking: false,
		}
		return { id: modelId, info: modelInfoFromSchema }
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

	/**
	 * Provides an estimated token count for the given content blocks.
	 * This is a rough approximation as the actual tokenization is done by the model/UI.
	 * The ApiHandler interface requires this method.
	 * @param content An array of Anthropic ContentBlockParam objects.
	 * @returns A promise that resolves to the estimated number of tokens.
	 */
	async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		let textContent = ""
		if (content && Array.isArray(content)) {
			textContent = content
				.map((block) => {
					// Process only text blocks for token estimation
					if (block.type === "text") {
						return block.text
					}
					// You could assign a fixed token cost for other block types (e.g., images) if desired
					// For now, only text content is used for character-based estimation.
					return ""
				})
				.join("")
		}

		// Basic estimation: 1 token ~ 4 chars in English. This is very rough.
		const estimatedTokens = Math.ceil(textContent.length / 4)
		logger.warn(
			`[WebUiGeminiHandler:${this.modelName}] countTokens provides only a rough estimate (char_length/4 from text blocks). Actual tokenization is UI-dependent.`,
		)
		return estimatedTokens
	}

	public async dispose(): Promise<void> {
		logger.info(`[WebUiGeminiHandler:${this.modelName}] Disposing...`)
		if (this._initializationPromise) {
			try {
				await this._initializationPromise
			} catch (e: any) {
				logger.debug(`[WebUiGeminiHandler:${this.modelName}] Init promise rejected during dispose`, {
					details: e?.message,
					stack: e?.stack,
				})
			} finally {
				this._initializationPromise = null
			}
		}
		await this._cleanupPuppeteerResources()
		logger.info(`[WebUiGeminiHandler:${this.modelName}] Disposed.`)
	}
}
