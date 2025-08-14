// File: Roo-Copy/src/api/providers/web-ui-studio.ts

import puppeteer, { Page, Browser, ConnectOptions } from "puppeteer-core"

import { discoverChromeHostUrl } from "../../services/browser/browserDiscovery"
import { logger } from "../../utils/logging"
import { type ApiHandlerOptions } from "../../shared/api"
import { type ModelInfo } from "@roo-code/types"
import { type Anthropic } from "@anthropic-ai/sdk" // For MessageParam type

import { type ApiStream } from "../transform/stream"
import { type ApiHandler } from "../index" // Adjust path as needed

// Default values
const DEFAULT_STUDIO_APP_URL = "https://aistudio.google.com/"
const DEFAULT_DISCOVERY_PORT = 9222
const DEFAULT_PUPPETEER_TIMEOUT = 60000
const DEFAULT_MODEL_DISPLAY_NAME = "studio-via-browser"

const DEFAULT_REGENERATION_PROMPT = "PLACEHOLDER"

const DEFAULT_MALFORMED_TOKEN_LIST = "PLACEHOLDER"

// UI Selectors for AI Studio
const PROMPT_TEXTAREA_SELECTOR = 'textarea[aria-label="Start typing a prompt"]'
const SUBMIT_BUTTON_BASE_SELECTOR = 'button[aria-label="Run"]'
const CLICKABLE_SEND_BUTTON_SELECTOR = `${SUBMIT_BUTTON_BASE_SELECTOR}:not([disabled])`
const PROCESSING_STOPPABLE_BUTTON_SELECTOR = `${SUBMIT_BUTTON_BASE_SELECTOR}.stoppable` // Button when busy, shows "Stop"
const DISABLED_RUN_BUTTON_SELECTOR = `${SUBMIT_BUTTON_BASE_SELECTOR}[aria-disabled="true"]`
// Ready for new input is when PROCESSING_STOPPABLE_BUTTON_SELECTOR is not present, and SUBMIT_BUTTON_BASE_SELECTOR is not disabled.
const MODEL_RESPONSE_ROOT_SELECTOR = "div.chat-turn-container.model" // Targets the div that has the .model class
const RESPONSE_MARKDOWN_SELECTOR = "ms-cmark-node" // Note: We keep this for reference but the new method doesn't use it.
// --- NEW SELECTORS ---
const MORE_OPTIONS_BUTTON_SELECTOR = 'ms-chat-turn-options button[aria-label="Open options"]'
const COPY_MARKDOWN_BUTTON_SELECTOR = "button.mat-mdc-menu-item:has(span.copy-markdown-button)"
// --- END NEW SELECTORS ---

export class WebUiStudioHandler implements ApiHandler {
	public readonly modelName: string

	private _browser: Browser | null = null
	private _page: Page | null = null
	private _isInitialized = false
	private _initializationPromise: Promise<void> | null = null

	private readonly puppeteerBaseUrl: string
	private readonly discoveryPort: number
	private readonly puppeteerTimeout: number
	private readonly regenerationPrompt: string
	private readonly malformedTokenList: string[]

	private readonly options: ApiHandlerOptions

	constructor(options: ApiHandlerOptions) {
		this.options = options

		this.puppeteerBaseUrl = options.webUiStudioBaseUrl || DEFAULT_STUDIO_APP_URL
		this.discoveryPort = options.webUiStudioDiscoveryPort || DEFAULT_DISCOVERY_PORT
		this.puppeteerTimeout = options.webUiStudioPuppeteerTimeout || DEFAULT_PUPPETEER_TIMEOUT
		this.regenerationPrompt = options.webUiStudioRegenerationPrompt || DEFAULT_REGENERATION_PROMPT
		this.malformedTokenList = ((options.webUiStudioMalformedTokenList || DEFAULT_MALFORMED_TOKEN_LIST) as string)
			.replace(/\\n/g, "\n") // Unescape \\n to \n
			.split(",")
			.map((s) => s) // Removed .trim()
			.filter((s) => s !== "")

		this.modelName = (options as any).model || (options as any).apiModelId || DEFAULT_MODEL_DISPLAY_NAME

		logger.info(
			`[WebUiStudioHandler:${this.modelName}] Constructed. Config: ${JSON.stringify({
				baseUrl: this.puppeteerBaseUrl,
				modelName: this.modelName,
				discoveryPort: this.discoveryPort,
				puppeteerTimeout: this.puppeteerTimeout,
				regenerationPrompt: this.regenerationPrompt.substring(0, 50) + "...",
				malformedTokenList: this.malformedTokenList,
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

			// --- ADDED FOR CLIPBOARD ACCESS ---
			// Grant clipboard permissions to the browser context
			const context = this._browser.defaultBrowserContext()
			await context.overridePermissions(this.puppeteerBaseUrl, ["clipboard-read", "clipboard-write"])
			logger.info(`[WebUiStudioHandler:${this.modelName}] Granted clipboard permissions.`)
			// --- END OF ADDED BLOCK ---

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
				await this._page.evaluate(
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
					ZERO_STATE_TEXTAREA_SELECTOR,
					this.regenerationPrompt,
				)

				// Wait for the zero-state run button to become enabled and click it
				const zeroStateRunButton = await this._page.waitForSelector(ZERO_STATE_ENABLED_RUN_BUTTON_SELECTOR, {
					visible: true,
				})
				await zeroStateRunButton!.click()
				logger.info(`[WebUiStudioHandler:${this.modelName}] Clicked Run button in zero-state.`)

				// Wait for the zero-state to disappear or the main prompt area to appear
				await this._page.waitForFunction(
					(zRootSel, mainPromptSel, disabledRunButtonSel) => {
						const zeroStateGone = !document.querySelector(zRootSel)
						const mainPromptAppeared = !!document.querySelector(mainPromptSel)
						const runButtonDisabled = !!document.querySelector(disabledRunButtonSel)

						return (zeroStateGone || mainPromptAppeared) && runButtonDisabled
					},
					{ timeout: this.puppeteerTimeout },
					ZERO_STATE_ROOT_SELECTOR,
					PROMPT_TEXTAREA_SELECTOR,
					DISABLED_RUN_BUTTON_SELECTOR,
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

		const latestMessage = messages[messages.length - 1]

		if (!latestMessage) {
			throw new Error("No message to relay")
		}

		let currentPrompt = ""
		if (messages.length === 1) {
			currentPrompt = `${systemPrompt}\n\n${getMessageContent(latestMessage)}`
		} else {
			currentPrompt = getMessageContent(latestMessage)
		}
		currentPrompt = currentPrompt.trim()

		let responseTextRaw = ""
		let decodedResponseText = "" // Declare here
		let attemptCount = 0
		const MAX_RETRY_ATTEMPTS = 3 // Prevent infinite loops

		while (attemptCount < MAX_RETRY_ATTEMPTS) {
			attemptCount++
			logger.info(
				`[WebUiStudioHandler:${this.modelName}] Sending prompt (Attempt ${attemptCount}). Timeout: ${this.puppeteerTimeout}ms.`,
			)
			logger.debug(`[WebUiStudioHandler:${this.modelName}] Prompt: "${currentPrompt.substring(0, 100)}..."`)

			try {
				await page.waitForSelector(PROMPT_TEXTAREA_SELECTOR, { visible: true })
				await page.evaluate((sel) => {
					const element = document.querySelector(sel) as HTMLElement
					if (element) {
						element.style.backgroundColor = "red"
					}
				}, PROMPT_TEXTAREA_SELECTOR)
				await page.focus(PROMPT_TEXTAREA_SELECTOR)

				const currentInitialResponseCount = await page.$$eval(MODEL_RESPONSE_ROOT_SELECTOR, (els) => els.length)

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
					currentPrompt,
				)

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
				await page.evaluate((sel) => {
					const element = document.querySelector(sel) as HTMLElement
					if (element) {
						element.style.backgroundColor = "" // Reset to normal
					}
				}, PROMPT_TEXTAREA_SELECTOR)
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
					await new Promise((resolve) => setTimeout(resolve, 500))
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

				// --- REWORKED LOGIC STARTS HERE ---
				// New Method: Find the 'more options' button, click it, then click 'copy markdown'
				logger.debug(
					`[WebUiStudioHandler:${this.modelName}] Finding "More options" button in the new response turn.`,
				)
				const moreOptionsButton = await newModelResponseElement.$(MORE_OPTIONS_BUTTON_SELECTOR)
				if (!moreOptionsButton) {
					throw new Error("Could not find the 'More options' button on the new response.")
				}

				await moreOptionsButton.click()
				logger.debug(`[WebUiStudioHandler:${this.modelName}] Clicked "More options" button.`)

				// --- START OF NEW, ROBUST BLOCK ---
				// Wait for the button to be visible in the DOM
				await page.waitForSelector(COPY_MARKDOWN_BUTTON_SELECTOR, { visible: true, timeout: 5000 })
				logger.debug(`[WebUiStudioHandler:${this.modelName}] "Copy markdown" button is visible.`)

				// Use page.evaluate to perform a more reliable, native click.
				// This is less prone to race conditions with the site's JavaScript framework.
				const clicked = await page.evaluate((selector) => {
					const button = document.querySelector(selector) as HTMLElement
					if (button) {
						button.click()
						return true // Signal that the click was attempted
					}
					return false // Signal that the button was not found in the DOM at the time of execution
				}, COPY_MARKDOWN_BUTTON_SELECTOR)

				if (!clicked) {
					throw new Error(
						"Failed to find and click 'Copy markdown' button via page.evaluate. The button may have disappeared.",
					)
				}

				logger.debug(`[WebUiStudioHandler:${this.modelName}] Executed native click on "Copy markdown" button.`)

				// Add a brief pause to ensure the OS-level clipboard operation has time to complete
				await new Promise((resolve) => setTimeout(resolve, 250))
				// --- END OF NEW, ROBUST BLOCK ---

				// Read the content directly from the browser's clipboard
				responseTextRaw = await page.evaluate(() => navigator.clipboard.readText())
				if (!responseTextRaw) {
					throw new Error("Copied text from clipboard was empty.")
				}
				// --- REWORKED LOGIC ENDS HERE ---

				decodedResponseText = responseTextRaw.trim()
				logger.debug(
					`[WebUiStudioHandler:${this.modelName}] Response: "${decodedResponseText.substring(0, 200)}..."`,
				)

				const ignoreToken = "Potential filter text that#1 would trigger regeneration, not used right now"
				const applyDiffEndToken = "Potential filter text#2 that would trigger regeneration, not used right now"
				const occurrencesOfIgnoreToken = (decodedResponseText.match(new RegExp(ignoreToken, "g")) || []).length
				const occurrencesOfApplyDiffEndToken = (
					decodedResponseText.match(new RegExp(applyDiffEndToken, "g")) || []
				).length

				if (occurrencesOfIgnoreToken > 1 || occurrencesOfApplyDiffEndToken >= 1) {
					logger.warn(
						`[WebUiStudioHandler:${this.modelName}] Response contains regeneration trigger. Regenerating.`,
					)
					currentPrompt = this.regenerationPrompt
					// Continue loop to resend
				} else {
					yield { type: "text", text: decodedResponseText }
					yield { type: "usage", inputTokens: 0, outputTokens: 0 }
					break // Exit loop if no regeneration trigger
				}
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

		const ignoreToken = "IGNORE_WHEN_COPYING_END"
		const applyDiffEndToken = "</apply_diff>\n```" // Hex: 3c 2f 61 70 70 6c 79 5f 64 69 66 66 3e 0d 0a 60 60 60
		const occurrencesOfIgnoreToken = (decodedResponseText.match(new RegExp(ignoreToken, "g")) || []).length
		const occurrencesOfApplyDiffEndToken = (decodedResponseText.match(new RegExp(applyDiffEndToken, "g")) || [])
			.length

		if (
			attemptCount >= MAX_RETRY_ATTEMPTS &&
			(occurrencesOfIgnoreToken > 1 || occurrencesOfApplyDiffEndToken >= 1)
		) {
			logger.error(
				`[WebUiStudioHandler:${this.modelName}] Max retry attempts reached, but response still contains regeneration trigger.`,
			)
			yield {
				type: "text",
				text: `Error: Max regeneration attempts reached. Response still contains regeneration trigger.\n\n${responseTextRaw}`,
			}
			yield { type: "usage", inputTokens: 0, outputTokens: 0 }
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

/**
 * Extract text content from message object
 * @param message
 */
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
