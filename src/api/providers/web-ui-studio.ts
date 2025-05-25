// File: Roo-Copy/src/api/providers/web-ui-studio.ts

import puppeteer, { Page, Browser, ConnectOptions } from "puppeteer-core"

import { discoverChromeHostUrl } from "../../services/browser/browserDiscovery"
import { logger } from "../../utils/logging"
import { type ApiHandlerOptions, type ModelInfo } from "../../shared/api"
import { type Anthropic } from "@anthropic-ai/sdk" // For MessageParam type

import { type ApiStream } from "../transform/stream"
import { type ApiHandler } from "../index" // Adjust path as needed

// Default values
const DEFAULT_STUDIO_APP_URL = "https://aistudio.google.com/prompts/new_chat"
const DEFAULT_DISCOVERY_PORT = 9222
const DEFAULT_PUPPETEER_TIMEOUT = 60000
const DEFAULT_MODEL_DISPLAY_NAME = "studio-via-browser"

// UI Selectors for AI Studio
const PROMPT_TEXTAREA_SELECTOR = 'textarea[aria-label="Start typing a prompt"]'
const SUBMIT_BUTTON_BASE_SELECTOR = 'button[aria-label="Run"]'
const CLICKABLE_SEND_BUTTON_SELECTOR = `${SUBMIT_BUTTON_BASE_SELECTOR}:not([disabled])`
const PROCESSING_STOPPABLE_BUTTON_SELECTOR = `${SUBMIT_BUTTON_BASE_SELECTOR}.stoppable` // Button when busy, shows "Stop"
// Ready for new input is when PROCESSING_STOPPABLE_BUTTON_SELECTOR is not present, and SUBMIT_BUTTON_BASE_SELECTOR is not disabled.
const MODEL_RESPONSE_ROOT_SELECTOR = "div.chat-turn-container.model" // Targets the div that has the .model class
const RESPONSE_MARKDOWN_SELECTOR = "ms-cmark-node"

function decodeXmlEntities(encodedString: string): string {
	if (!encodedString) return ""
	return encodedString.replace(/</g, "<").replace(/>/g, ">").replace(/&/g, "&").replace(/"/g, '"').replace(/'/g, "'")
}

export class WebUiStudioHandler implements ApiHandler {
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

		this.puppeteerBaseUrl = (options as any).webUiStudioBaseUrl || DEFAULT_STUDIO_APP_URL
		this.discoveryPort = (options as any).webUiStudioDiscoveryPort || DEFAULT_DISCOVERY_PORT
		this.puppeteerTimeout = (options as any).webUiStudioPuppeteerTimeout || DEFAULT_PUPPETEER_TIMEOUT

		this.modelName = (options as any).model || (options as any).apiModelId || DEFAULT_MODEL_DISPLAY_NAME

		logger.info(
			`[WebUiStudioHandler:${this.modelName}] Constructed. Config: ${JSON.stringify({
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
				logger.error(`[WebUiStudioHandler:${this.modelName}] Initialization error`, {
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
			throw new Error("WebUiStudioHandler failed to initialize.")
		}
	}

	private async _initializeInternal(): Promise<void> {
		logger.info(
			`[WebUiStudioHandler:${this.modelName}] Internal init. Port: ${this.discoveryPort}, URL: ${this.puppeteerBaseUrl}`,
		)
		this._isInitialized = false

		const discoveredBrowserURL = await discoverChromeHostUrl(this.discoveryPort)
		if (!discoveredBrowserURL) {
			const errorMsg = `No browser on port ${this.discoveryPort}. Ensure a debuggable browser is running.`
			logger.error(`[WebUiStudioHandler:${this.modelName}] ${errorMsg}`)
			throw new Error(errorMsg)
		}
		logger.info(
			`[WebUiStudioHandler:${this.modelName}] Discovered browser at ${discoveredBrowserURL}. Connecting...`,
		)

		try {
			const connectOptions: ConnectOptions = {
				browserURL: discoveredBrowserURL,
				defaultViewport: null, // Adjust as needed, e.g., { width: 1920, height: 1080 }
			}
			this._browser = await puppeteer.connect(connectOptions)
			logger.info(`[WebUiStudioHandler:${this.modelName}] Connected to browser: ${await this._browser.version()}`)
			this._browser.on("disconnected", () => {
				logger.warn(`[WebUiStudioHandler:${this.modelName}] Browser disconnected.`)
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
				logger.info(`[WebUiStudioHandler:${this.modelName}] Navigating to ${this.puppeteerBaseUrl}`)
				await this._page.goto(this.puppeteerBaseUrl, { waitUntil: "networkidle2" })
			} else {
				logger.info(`[WebUiStudioHandler:${this.modelName}] Page already at target URL: ${this._page.url()}`)
			}

			this._page.on("close", () => {
				logger.warn(`[WebUiStudioHandler:${this.modelName}] Page closed.`)
				this._page = null
				this._isInitialized = false
			})
			this._page.on("error", (err: Error) => {
				logger.error(`[WebUiStudioHandler:${this.modelName}] Page crashed`, {
					details: err.message,
					stack: err.stack,
				})
				this._page = null
				this._isInitialized = false
			})
			this._page.on("pageerror", (err: Error) => {
				logger.error(`[WebUiStudioHandler:${this.modelName}] Unhandled page exception`, {
					details: err.message,
					stack: err.stack,
				})
			})

			// Check for and handle the initial zero-state UI
			const ZERO_STATE_ROOT_SELECTOR = "ms-zero-state"
			const ZERO_STATE_TEXTAREA_SELECTOR =
				'ms-zero-state textarea[aria-label="Type something or tab to choose an example prompt"]'
			// The run button in zero state might initially be disabled
			const ZERO_STATE_ENABLED_RUN_BUTTON_SELECTOR = 'ms-zero-state button[aria-label="Run"]:not([disabled])'

			try {
				await this._page.waitForSelector(ZERO_STATE_ROOT_SELECTOR, { visible: true, timeout: 5000 }) // Short timeout to check if it's there
				logger.info(
					`[WebUiStudioHandler:${this.modelName}] Zero-state UI detected. Attempting to submit initial prompt.`,
				)

				// Type into the zero-state textarea
				await this._page.waitForSelector(ZERO_STATE_TEXTAREA_SELECTOR, { visible: true })
				await this._page.type(ZERO_STATE_TEXTAREA_SELECTOR, "Hello", { delay: 50 })

				// Wait for the zero-state run button to become enabled and click it
				const zeroStateRunButton = await this._page.waitForSelector(ZERO_STATE_ENABLED_RUN_BUTTON_SELECTOR, {
					visible: true,
				})
				await zeroStateRunButton!.click()
				logger.info(`[WebUiStudioHandler:${this.modelName}] Clicked Run button in zero-state.`)

				// Wait for the zero-state to disappear or the main prompt area to appear
				await this._page.waitForFunction(
					(zRootSel, mainPromptSel) => {
						return !document.querySelector(zRootSel) || !!document.querySelector(mainPromptSel)
					},
					{ timeout: this.puppeteerTimeout },
					ZERO_STATE_ROOT_SELECTOR,
					PROMPT_TEXTAREA_SELECTOR,
				)
				logger.info(`[WebUiStudioHandler:${this.modelName}] Zero-state UI likely transitioned.`)
				logger.info(
					`[WebUiStudioHandler:${this.modelName}] Waiting 10 seconds for main UI to stabilize after zero-state transition...`,
				)
				await new Promise((resolve) => setTimeout(resolve, 10000))
			} catch (e) {
				logger.info(
					`[WebUiStudioHandler:${this.modelName}] Zero-state UI not detected or failed to interact with it, proceeding to check for main UI. Error: ${(e as Error).message}`,
				)
			}

			// Wait for the main chat input area (this should now appear after zero-state interaction or if it was there initially)
			await this._page.waitForSelector(PROMPT_TEXTAREA_SELECTOR, { visible: true })
			this._isInitialized = true
			logger.info(
				`[WebUiStudioHandler:${this.modelName}] Internal initialization complete. Page ready at ${this._page.url()}`,
			)
		} catch (error: any) {
			await this._cleanupPuppeteerResources(true)
			const errorMsg = error?.message || "Unknown initialization error"
			logger.error(`[WebUiStudioHandler:${this.modelName}] Error during _initializeInternal`, {
				details: errorMsg,
				stack: error?.stack,
				errorObj: error,
			})
			throw new Error(errorMsg, { cause: error })
		}
	}

	private async _cleanupPuppeteerResources(silent = false): Promise<void> {
		if (!silent) logger.info(`[WebUiStudioHandler:${this.modelName}] Cleaning Puppeteer resources...`)
		this._isInitialized = false
		// Don't close the page here if we didn't open it, just detach from it.
		// If we created the page (_browser.newPage()), then it could be closed.
		// For now, let's assume we might be attaching to an existing page.
		this._page = null // Nullify to indicate it's no longer managed by this instance

		if (this._browser && this._browser.isConnected()) {
			try {
				// disconnect() is preferred over close() when using puppeteer.connect()
				// to avoid closing the entire browser if other sessions are active.
				await this._browser.disconnect()
			} catch (e: any) {
				if (!silent)
					logger.error(`[WebUiStudioHandler:${this.modelName}] Error disconnecting browser`, {
						details: e?.message,
						stack: e?.stack,
					})
			}
		}
		this._browser = null
		if (!silent) logger.info(`[WebUiStudioHandler:${this.modelName}] Puppeteer resources cleanup finished.`)
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		await this._ensureInitialized()
		if (!this._page || this._page.isClosed()) {
			throw new Error("WebUiStudioHandler: Page is not available for API call.")
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

		logger.info(`[WebUiStudioHandler:${this.modelName}] Sending prompt. Timeout: ${this.puppeteerTimeout}ms.`)
		logger.debug(`[WebUiStudioHandler:${this.modelName}] Prompt: "${fullPrompt.substring(0, 200)}..."`)

		try {
			await page.waitForSelector(PROMPT_TEXTAREA_SELECTOR, { visible: true })
			// For AI Studio's textarea, direct manipulation might be more reliable
			await page.evaluate(
				(selector, text) => {
					const textarea = document.querySelector(selector) as HTMLTextAreaElement
					if (textarea) {
						textarea.focus()
						textarea.value = text // Directly set value
						// Dispatch input event to ensure frameworks (Angular) detect the change
						textarea.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }))
						textarea.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }))
					} else {
						throw new Error(`Selector '${selector}' not found for prompt input.`)
					}
				},
				PROMPT_TEXTAREA_SELECTOR,
				fullPrompt,
			)

			const currentInitialResponseCount = await page.$$eval(MODEL_RESPONSE_ROOT_SELECTOR, (els) => els.length)
			logger.debug(
				`[WebUiStudioHandler:${this.modelName}] Initial response count: ${currentInitialResponseCount}`,
			)

			const sendButton = await page.waitForSelector(CLICKABLE_SEND_BUTTON_SELECTOR, {
				visible: true,
				timeout: 10000,
			})
			if (!sendButton) {
				throw new Error("AI Studio: Send (Run) button not found or not clickable.")
			}
			await sendButton.click()
			logger.debug(`[WebUiStudioHandler:${this.modelName}] Clicked send button.`)

			// Wait for the "Run" button to change to "Stop" (add .stoppable class and spinner)
			logger.debug(
				`[WebUiStudioHandler:${this.modelName}] Waiting for processing button to appear: ${PROCESSING_STOPPABLE_BUTTON_SELECTOR}`,
			)
			await page.waitForSelector(PROCESSING_STOPPABLE_BUTTON_SELECTOR, {
				visible: true,
				timeout: this.puppeteerTimeout,
			})
			logger.debug(`[WebUiStudioHandler:${this.modelName}] Processing button appeared.`)

			// Wait for the "Stop" button/state to disappear (processing finished)
			logger.debug(
				`[WebUiStudioHandler:${this.modelName}] Waiting for processing button to disappear: ${PROCESSING_STOPPABLE_BUTTON_SELECTOR}`,
			)
			await page.waitForSelector(PROCESSING_STOPPABLE_BUTTON_SELECTOR, {
				hidden: true,
				timeout: this.puppeteerTimeout,
			})
			logger.debug(`[WebUiStudioHandler:${this.modelName}] Processing (stoppable) button disappeared.`)

			// Check if the Run button is now disabled (the state user mentioned for an extra pause)
			const isRunButtonDisabledAfterProcessing = await page.evaluate((selector) => {
				const button = document.querySelector(selector)
				return button?.hasAttribute("disabled") && !button.classList.contains("stoppable")
			}, SUBMIT_BUTTON_BASE_SELECTOR)

			if (isRunButtonDisabledAfterProcessing) {
				logger.info(
					`[WebUiStudioHandler:${this.modelName}] Run button is disabled after processing. Waiting 11 seconds before reading output.`,
				)
				await new Promise((resolve) => setTimeout(resolve, 11000))
			}

			// The UI is now expected to have finished processing the request.
			// The Run button might be disabled if the input text area is empty.
			// We proceed directly to look for the response.
			logger.debug(`[WebUiStudioHandler:${this.modelName}] Proceeding to find response content.`)

			const waitSuccess = await page.waitForFunction(
				(sel, count, checkInterval, funcTimeout) => {
					return new Promise((resolve) => {
						const startTime = Date.now()
						const interval = setInterval(() => {
							const currentCount = document.querySelectorAll(sel).length
							if (currentCount > count) {
								clearInterval(interval)
								resolve(true)
							} else if (Date.now() - startTime > funcTimeout) {
								clearInterval(interval)
								console.warn(
									`waitForFunction timeout for ${sel}. Current count: ${currentCount}, expected > ${count}`,
								)
								resolve(false)
							}
						}, checkInterval)
					})
				},
				{ timeout: this.puppeteerTimeout }, // Overall timeout for this waitForFunction
				MODEL_RESPONSE_ROOT_SELECTOR,
				currentInitialResponseCount,
				200, // checkInterval
				this.puppeteerTimeout - 1000, // funcTimeout (slightly less than overall)
			)

			if (!waitSuccess) {
				const finalCount = await page.$$eval(MODEL_RESPONSE_ROOT_SELECTOR, (els) => els.length)
				throw new Error(
					`Timeout waiting for new model response to appear. Initial: ${currentInitialResponseCount}, Final: ${finalCount}. Selector: ${MODEL_RESPONSE_ROOT_SELECTOR}`,
				)
			}
			logger.debug(`[WebUiStudioHandler:${this.modelName}] New model response root appeared.`)

			const currentResponseRoots = await page.$$(MODEL_RESPONSE_ROOT_SELECTOR)
			logger.debug(
				`[WebUiStudioHandler:${this.modelName}] Found ${currentResponseRoots.length} response roots. Expected > ${currentInitialResponseCount}`,
			)

			if (currentInitialResponseCount >= currentResponseRoots.length) {
				throw new Error(
					`New model response root not found after waitForFunction. Expected >${currentInitialResponseCount}, got ${currentResponseRoots.length}`,
				)
			}
			// The new response is the one at index currentInitialResponseCount (if one new) or the last one.
			// It's safer to assume the last one is the newest if multiple could appear.
			const newModelResponseElement = currentResponseRoots[currentResponseRoots.length - 1]

			let newResponseMarkdownElement = null
			const retryTimeout = 20000 // 10 seconds for retries
			const retryInterval = 1000 // 0.5 seconds interval
			const startTime = Date.now()

			while (Date.now() - startTime < retryTimeout) {
				newResponseMarkdownElement = await newModelResponseElement.$(RESPONSE_MARKDOWN_SELECTOR)
				if (newResponseMarkdownElement) {
					logger.debug(
						`[WebUiStudioHandler:${this.modelName}] Found markdown panel after ${Date.now() - startTime}ms.`,
					)
					break
				}
				logger.debug(
					`[WebUiStudioHandler:${this.modelName}] Markdown panel not found, retrying in ${retryInterval}ms...`,
				)
				await new Promise((resolve) => setTimeout(resolve, retryInterval))
			}

			if (!newResponseMarkdownElement) {
				const outerHtml = await newModelResponseElement.evaluate((el) => el.outerHTML)
				logger.error(
					`[WebUiStudioHandler:${this.modelName}] Markdown panel in new response not found after ${retryTimeout}ms. Selector: ${RESPONSE_MARKDOWN_SELECTOR}. Parent HTML: ${outerHtml.substring(0, 500)}`,
				)
				throw new Error(`Markdown panel in new response not found after ${retryTimeout}ms.`)
			}

			// AI Studio responses might be structured differently, ensure text extraction is robust
			const responseTextRaw = await newResponseMarkdownElement.evaluate((el) => {
				// Attempt to get combined text content from all child nodes,
				// as AI Studio might use nested elements within ms-cmark-node
				let text = ""
				el.childNodes.forEach((child) => {
					if (child.nodeType === Node.TEXT_NODE) {
						text += child.textContent
					} else if (child.nodeType === Node.ELEMENT_NODE) {
						text += (child as HTMLElement).innerText // Or .textContent
					}
				})
				return text || (el as HTMLElement).innerText // Fallback to innerText
			})
			const decodedResponseText = decodeXmlEntities(responseTextRaw).trim()
			logger.debug(
				`[WebUiStudioHandler:${this.modelName}] Response: "${decodedResponseText.substring(0, 200)}..."`,
			)

			yield { type: "text", text: decodedResponseText }
			// TODO: Implement token counting if possible from UI or estimate
			yield { type: "usage", inputTokens: 0, outputTokens: 0 }
		} catch (error: any) {
			const errorMsg = error?.message || "Unknown Puppeteer interaction error"
			logger.error(`[WebUiStudioHandler:${this.modelName}] Puppeteer interaction error`, {
				details: errorMsg,
				stack: error?.stack,
				errorObj: error,
			})
			if (this._page?.isClosed() || (this._browser && !this._browser.isConnected())) {
				logger.warn(
					`[WebUiStudioHandler:${this.modelName}] Page or browser disconnected during error handling.`,
				)
				this._isInitialized = false
				this._initializationPromise = null // Reset to allow re-initialization
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
			contextWindow: 32000, // Adjust if known for Studio models
			supportsImages: false, // Update if AI Studio supports image inputs via this UI
			supportsPromptCache: false,
			inputPrice: undefined,
			outputPrice: undefined,
			description: `AI Studio Web UI via Puppeteer (${modelId})`,
			supportsComputerUse: false,
			thinking: false, // AI Studio has a "Thoughts" panel, this might be true.
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

	async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		let textContent = ""
		if (content && Array.isArray(content)) {
			textContent = content
				.map((block) => {
					if (block.type === "text") {
						return block.text
					}
					return ""
				})
				.join("")
		}
		const estimatedTokens = Math.ceil(textContent.length / 4)
		logger.warn(
			`[WebUiStudioHandler:${this.modelName}] countTokens provides only a rough estimate (char_length/4 from text blocks). Actual tokenization is UI-dependent.`,
		)
		return estimatedTokens
	}

	public async dispose(): Promise<void> {
		logger.info(`[WebUiStudioHandler:${this.modelName}] Disposing...`)
		if (this._initializationPromise) {
			try {
				await this._initializationPromise
			} catch (e: any) {
				logger.debug(`[WebUiStudioHandler:${this.modelName}] Init promise rejected during dispose`, {
					details: e?.message,
					stack: e?.stack,
				})
			} finally {
				this._initializationPromise = null
			}
		}
		await this._cleanupPuppeteerResources()
		logger.info(`[WebUiStudioHandler:${this.modelName}] Disposed.`)
	}
}
