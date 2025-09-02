// File: Roo-Copy/src/api/providers/web-ui-studio.ts

import puppeteer, { Page, Browser, ConnectOptions, CDPSession } from "puppeteer-core"

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
const DEFAULT_ZERO_STATE_PROMPT = "What is today's date?"

const DEFAULT_MALFORMED_TOKEN_LIST = "PLACEHOLDER"

// UI Selectors for AI Studio
const PROMPT_TEXTAREA_SELECTOR = 'textarea[aria-label="Start typing a prompt"]'
const SUBMIT_BUTTON_BASE_SELECTOR = 'button[aria-label="Run"]'
const CLICKABLE_SEND_BUTTON_SELECTOR = `${SUBMIT_BUTTON_BASE_SELECTOR}:not([disabled])`
const PROCESSING_STOPPABLE_BUTTON_SELECTOR = `${SUBMIT_BUTTON_BASE_SELECTOR}.stoppable` // Button when busy, shows "Stop"
const DISABLED_RUN_BUTTON_SELECTOR = `${SUBMIT_BUTTON_BASE_SELECTOR}[aria-disabled="true"]`
// Ready for new input is when PROCESSING_STOPPABLE_BUTTON_SELECTOR is not present, and SUBMIT_BUTTON_BASE_SELECTOR is not disabled.
// Network interception replaces UI automation for response retrieval

export class WebUiStudioHandler implements ApiHandler {
	public readonly modelName: string

	private _browser: Browser | null = null
	private _page: Page | null = null
	private _cdpSession: CDPSession | null = null
	private _isInitialized = false
	private _initializationPromise: Promise<void> | null = null

	private readonly puppeteerBaseUrl: string
	private readonly discoveryPort: number
	private readonly puppeteerTimeout: number
	private readonly regenerationPrompt: string
	private readonly zeroStatePrompt: string
	private readonly malformedTokenList: string[]

	private readonly options: ApiHandlerOptions

	constructor(options: ApiHandlerOptions) {
		this.options = options

		this.puppeteerBaseUrl = options.webUiStudioBaseUrl || DEFAULT_STUDIO_APP_URL
		this.discoveryPort = options.webUiStudioDiscoveryPort || DEFAULT_DISCOVERY_PORT
		this.puppeteerTimeout = options.webUiStudioPuppeteerTimeout || DEFAULT_PUPPETEER_TIMEOUT
		this.regenerationPrompt = options.webUiStudioRegenerationPrompt || DEFAULT_REGENERATION_PROMPT
		this.zeroStatePrompt = (options as any).webUiStudioZeroStatePrompt || DEFAULT_ZERO_STATE_PROMPT
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
				zeroStatePrompt: this.zeroStatePrompt,
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

			this._cdpSession = await this._page.target().createCDPSession()
			await this._cdpSession.send("Network.setBypassServiceWorker", { bypass: true })

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
					this.zeroStatePrompt,
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
					`[WebUiStudioHandler:${this.modelName}] Waiting 5 seconds for main UI to stabilize after zero-state transition...`,
				)
				await new Promise((resolve) => setTimeout(resolve, 5000))
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
		if (this._cdpSession) {
			try {
				await this._cdpSession.detach()
			} catch (e: any) {
				if (!silent)
					logger.error(`[WebUiStudioHandler:${this.modelName}] Error detaching CDP session`, {
						details: e?.message,
						stack: e?.stack,
					})
			}
		}
		// Don't close the page here if we didn't open it, just detach from it.
		// If we created the page (_browser.newPage()), then it could be closed.
		// For now, let's assume we might be attaching to an existing page.
		this._page = null // Nullify to indicate it's no longer managed by this instance
		this._cdpSession = null

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
		if (!this._page || this._page.isClosed() || !this._cdpSession) {
			throw new Error("WebUiStudioHandler: Page or CDP session not available for API call.")
		}
		const page = this._page
		const cdp = this._cdpSession

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

		let attemptCount = 0
		const MAX_RETRY_ATTEMPTS = 3

		while (attemptCount < MAX_RETRY_ATTEMPTS) {
			attemptCount++
			logger.info(
				`[WebUiStudioHandler:${this.modelName}] Sending prompt (Attempt ${attemptCount}). Timeout: ${this.puppeteerTimeout}ms.`,
			)
			logger.debug(`[WebUiStudioHandler:${this.modelName}] Prompt: "${currentPrompt.substring(0, 100)}..."`)

			// Set up network interception - try Gemini's approach
			await cdp.send("Fetch.enable", {
				patterns: [{ urlPattern: "*GenerateContent*", requestStage: "Response" }],
			})

			let interceptionComplete = false
			let accumulatedContent = ""
			let regenerationNeeded = false

			const onPaused = async (event: any) => {
				const { requestId, request } = event
				logger.debug(`[WebUiStudioHandler:${this.modelName}] ===== REQUEST INTERCEPTED =====`)
				logger.debug(`[WebUiStudioHandler:${this.modelName}] URL: ${request.url}`)
				logger.debug(`[WebUiStudioHandler:${this.modelName}] Method: ${request.method}`)
				logger.debug(`[WebUiStudioHandler:${this.modelName}] Request ID: ${requestId}`)
				logger.debug(
					`[WebUiStudioHandler:${this.modelName}] Event properties: ${Object.keys(event).join(", ")}`,
				)
				logger.debug(`[WebUiStudioHandler:${this.modelName}] Response status: ${event.responseStatusCode}`)
				logger.debug(
					`[WebUiStudioHandler:${this.modelName}] Response headers count: ${event.responseHeaders?.length || 0}`,
				)
				logger.debug(
					`[WebUiStudioHandler:${this.modelName}] Request headers count: ${event.requestHeaders?.length || 0}`,
				)

				if (request.url.includes("GenerateContent")) {
					logger.info(`[WebUiStudioHandler:${this.modelName}] 🎯 GenerateContent request intercepted!`)

					// Check if this is a response by looking for response headers/status
					const isResponse =
						event.responseStatusCode !== undefined ||
						(event.responseHeaders && event.responseHeaders.length > 0)
					logger.debug(`[WebUiStudioHandler:${this.modelName}] Is response: ${isResponse}`)

					if (isResponse) {
						logger.info(`[WebUiStudioHandler:${this.modelName}] 📥 Processing GenerateContent RESPONSE`)
						try {
							logger.debug(`[WebUiStudioHandler:${this.modelName}] Fetching response body...`)
							const bodyData = await cdp.send("Fetch.getResponseBody", { requestId })
							logger.debug(`[WebUiStudioHandler:${this.modelName}] Body data received:`, {
								base64Encoded: bodyData.base64Encoded,
								bodyLength: bodyData.body?.length || 0,
							})

							const bodyText = bodyData.base64Encoded
								? Buffer.from(bodyData.body, "base64").toString("utf8")
								: bodyData.body

							logger.debug(
								`[WebUiStudioHandler:${this.modelName}] Decoded body length: ${bodyText.length}`,
							)
							logger.debug(
								`[WebUiStudioHandler:${this.modelName}] Body preview: "${bodyText.substring(0, 200)}..."`,
							)

							const parsedChunks = parseGenerateContentResponse(bodyText)
							logger.info(
								`[WebUiStudioHandler:${this.modelName}] ✅ Parsed ${parsedChunks.length} content chunks`,
							)

							if (parsedChunks.length > 0) {
								logger.debug(
									`[WebUiStudioHandler:${this.modelName}] Processing ${parsedChunks.length} chunks...`,
								)
								// Process and accumulate chunks for streaming
								for (let i = 0; i < parsedChunks.length; i++) {
									const chunk = parsedChunks[i]
									if (chunk.trim()) {
										accumulatedContent += chunk
										logger.debug(
											`[WebUiStudioHandler:${this.modelName}] Chunk ${i + 1}/${parsedChunks.length}: "${chunk.substring(0, 100)}..."`,
										)
									}
								}

								logger.info(
									`[WebUiStudioHandler:${this.modelName}] 📊 Total accumulated content: ${accumulatedContent.length} characters`,
								)

								// Check for regeneration triggers on accumulated content
								const ignoreToken =
									"Potential filter text that#1 would trigger regeneration, not used right now"
								const applyDiffEndToken =
									"Potential filter text#2 that would trigger regeneration, not used right now"
								const occurrencesOfIgnoreToken = (
									accumulatedContent.match(new RegExp(ignoreToken, "g")) || []
								).length
								const occurrencesOfApplyDiffEndToken = (
									accumulatedContent.match(new RegExp(applyDiffEndToken, "g")) || []
								).length

								logger.debug(
									`[WebUiStudioHandler:${this.modelName}] Regeneration check: ignoreToken=${occurrencesOfIgnoreToken}, applyDiffEndToken=${occurrencesOfApplyDiffEndToken}`,
								)

								if (occurrencesOfIgnoreToken > 1 || occurrencesOfApplyDiffEndToken >= 1) {
									logger.info(
										`[WebUiStudioHandler:${this.modelName}] 🔄 Response contains regeneration trigger. Triggering regeneration.`,
									)
									regenerationNeeded = true
									interceptionComplete = true
									logger.info(
										`[WebUiStudioHandler:${this.modelName}] 🏁 Setting interceptionComplete = true (regeneration)`,
									)
									cdp.off("Fetch.requestPaused", onPaused)
									try {
										await cdp.send("Fetch.disable")
									} catch {}
									return
								} else {
									// Normal response - mark interception complete
									logger.info(
										`[WebUiStudioHandler:${this.modelName}] ✅ Normal response processed, setting interceptionComplete = true`,
									)
									interceptionComplete = true
								}
							} else {
								logger.warn(
									`[WebUiStudioHandler:${this.modelName}] ⚠️ No content chunks extracted from response`,
								)
								// Still mark as complete even if no content
								interceptionComplete = true
								logger.info(
									`[WebUiStudioHandler:${this.modelName}] 🏁 Setting interceptionComplete = true (no content)`,
								)
							}
						} catch (e: any) {
							logger.error(
								`[WebUiStudioHandler:${this.modelName}] ❌ Error processing GenerateContent response`,
								{
									error: e.message,
									stack: e.stack,
								},
							)
							// Mark as complete even on error to avoid infinite waiting
							interceptionComplete = true
							logger.info(
								`[WebUiStudioHandler:${this.modelName}] 🏁 Setting interceptionComplete = true (error)`,
							)
						} finally {
							if (!page.isClosed()) {
								try {
									logger.debug(
										`[WebUiStudioHandler:${this.modelName}] Continuing request after processing`,
									)
									await cdp.send("Fetch.continueRequest", { requestId })
								} catch (e: any) {
									logger.error(
										`[WebUiStudioHandler:${this.modelName}] Error continuing request after processing`,
										{ error: e.message },
									)
								}
							}
						}
					} else {
						// This is a request, continue it
						logger.debug(`[WebUiStudioHandler:${this.modelName}] 📤 Continuing GenerateContent REQUEST`)
						if (!page.isClosed()) {
							try {
								await cdp.send("Fetch.continueRequest", { requestId })
							} catch (e: any) {
								logger.error(`[WebUiStudioHandler:${this.modelName}] Error continuing request`, {
									error: e.message,
								})
							}
						}
					}
				} else {
					logger.debug(
						`[WebUiStudioHandler:${this.modelName}] 🔄 Non-GenerateContent request, continuing: ${request.url}`,
					)
					if (!page.isClosed()) {
						try {
							await cdp.send("Fetch.continueRequest", { requestId })
						} catch {}
					}
				}
				logger.debug(`[WebUiStudioHandler:${this.modelName}] ===== REQUEST PROCESSING COMPLETE =====`)
			}

			cdp.on("Fetch.requestPaused", onPaused)

			// Set up timeout
			const timeoutPromise = new Promise<never>((_, reject) => {
				logger.debug(`[WebUiStudioHandler:${this.modelName}] Setting timeout for ${this.puppeteerTimeout}ms`)
				setTimeout(() => {
					logger.error(
						`[WebUiStudioHandler:${this.modelName}] Timeout reached. interceptionComplete: ${interceptionComplete}`,
					)
					if (!interceptionComplete) {
						cdp.off("Fetch.requestPaused", onPaused)
						try {
							cdp.send("Fetch.disable")
						} catch {}
						reject(
							new Error(
								`Timeout waiting for GenerateContent response (waited ${this.puppeteerTimeout} ms).`,
							),
						)
					}
				}, this.puppeteerTimeout)
			})

			try {
				// Add visual marker
				await page.waitForSelector(PROMPT_TEXTAREA_SELECTOR, { visible: true })
				await page.evaluate((sel) => {
					const element = document.querySelector(sel) as HTMLElement
					if (element) {
						element.style.backgroundColor = "red"
					}
				}, PROMPT_TEXTAREA_SELECTOR)

				// Type the prompt
				await page.evaluate(
					(selector, text) => {
						const textarea = document.querySelector(selector) as HTMLTextAreaElement
						if (textarea) {
							textarea.focus()
							textarea.value = text
							textarea.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }))
							textarea.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }))
						} else {
							throw new Error(`Selector '${selector}' not found for prompt input.`)
						}
					},
					PROMPT_TEXTAREA_SELECTOR,
					currentPrompt,
				)

				// Click send button
				const sendButton = await page.waitForSelector(CLICKABLE_SEND_BUTTON_SELECTOR, {
					visible: true,
					timeout: 10000,
				})
				if (!sendButton) {
					throw new Error("AI Studio: Send (Run) button not found or not clickable.")
				}

				// Remove visual marker
				await page.evaluate((sel) => {
					const element = document.querySelector(sel) as HTMLElement
					if (element) {
						element.style.backgroundColor = ""
					}
				}, PROMPT_TEXTAREA_SELECTOR)

				await sendButton.click()
				logger.debug(`[WebUiStudioHandler:${this.modelName}] Clicked send button.`)

				// Wait for interception to complete or timeout
				logger.debug(`[WebUiStudioHandler:${this.modelName}] Waiting for interception to complete...`)
				await Promise.race([
					new Promise<void>((resolve) => {
						const checkComplete = () => {
							logger.debug(
								`[WebUiStudioHandler:${this.modelName}] Checking interception complete: ${interceptionComplete}`,
							)
							if (interceptionComplete) {
								logger.debug(
									`[WebUiStudioHandler:${this.modelName}] Interception completed successfully`,
								)
								resolve()
							} else {
								setTimeout(checkComplete, 100) // Check every 100ms
							}
						}
						checkComplete()
					}),
					timeoutPromise,
				])

				// Clean up interception
				cdp.off("Fetch.requestPaused", onPaused)
				try {
					await cdp.send("Fetch.disable")
				} catch {}

				logger.debug(
					`[WebUiStudioHandler:${this.modelName}] Interception complete. Accumulated content length: ${accumulatedContent.length}`,
				)

				if (regenerationNeeded) {
					logger.info(
						`[WebUiStudioHandler:${this.modelName}] Regeneration needed, retrying with regeneration prompt`,
					)
					currentPrompt = this.regenerationPrompt
					continue // Retry with regeneration prompt
				}

				if (accumulatedContent.trim()) {
					logger.debug(
						`[WebUiStudioHandler:${this.modelName}] Yielding final response: "${accumulatedContent.substring(0, 200)}..."`,
					)
					yield { type: "text", text: accumulatedContent }
					yield { type: "usage", inputTokens: 0, outputTokens: 0 }
					break // Success, exit retry loop
				} else {
					logger.error(`[WebUiStudioHandler:${this.modelName}] No content accumulated from response`)
					throw new Error("No content received from GenerateContent response")
				}
			} catch (error: any) {
				const errorMsg = error?.message || "Unknown error during network interception"

				if (errorMsg === "Regeneration required") {
					// This is a controlled regeneration flow
					currentPrompt = this.regenerationPrompt
					// Loop will continue to the next attempt
				} else {
					logger.error(`[WebUiStudioHandler:${this.modelName}] Network interception error`, {
						details: errorMsg,
						stack: error?.stack,
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
		}

		// Handle max retries reached
		if (attemptCount >= MAX_RETRY_ATTEMPTS) {
			logger.error(`[WebUiStudioHandler:${this.modelName}] Max retry attempts reached.`)
			yield {
				type: "text",
				text: `Error: Max regeneration attempts reached. Unable to get valid response.`,
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
 * Check if a string is actual content (not metadata)
 * @param str The string to check
 * @returns true if the string is content, false if it's metadata
 */
function isContentString(str: string): boolean {
	// Filter out metadata strings
	if (str.startsWith("v1:")) return false // Version tokens
	if (str === "model") return false // Model identifier
	if (/^\d{16,}$/.test(str)) return false // Long numeric strings (timestamps/IDs)
	if (str.length < 10 && !str.includes(" ")) return false // Very short non-spaced strings

	// Allow content strings
	return true
}

/**
 * Recursively find all string values in a nested object/array structure
 * @param obj The object/array to search
 * @returns Array of all string values found
 */
function findAllStrings(obj: any): string[] {
	const results: string[] = []

	if (typeof obj === "string" && obj.trim()) {
		results.push(obj)
	} else if (Array.isArray(obj)) {
		for (const item of obj) {
			results.push(...findAllStrings(item))
		}
	} else if (obj && typeof obj === "object") {
		for (const key in obj) {
			results.push(...findAllStrings(obj[key]))
		}
	}

	return results
}

/**
 * Parse GenerateContent response and extract text content chunks
 * @param jsonString Raw JSON response from GenerateContent endpoint
 * @returns Array of extracted text content chunks
 */
function parseGenerateContentResponse(jsonString: string): string[] {
	try {
		const data = JSON.parse(jsonString)
		logger.debug("[WebUiStudioHandler] Parsed JSON response, chunks count:", data?.length || 0)

		// Handle the deeply nested structure from the examples
		if (!Array.isArray(data) || data.length === 0) {
			logger.debug("[WebUiStudioHandler] No chunks in response")
			return []
		}

		const extractedChunks: string[] = []

		// Process each chunk in the response
		for (let i = 0; i < data.length; i++) {
			const chunk = data[i]
			logger.debug(`[WebUiStudioHandler] Processing chunk ${i}: ${JSON.stringify(chunk, null, 2)}`)

			if (!Array.isArray(chunk) || chunk.length === 0) {
				logger.debug(`[WebUiStudioHandler] Skipping non-array or empty chunk ${i}`)
				continue
			}

			try {
				// Try multiple navigation patterns to find content
				let content: any = null
				let foundPath = ""

				// Pattern 1: Original path
				if (chunk?.[0]?.[0]?.[0]?.[0]?.[0]?.[0]?.[0]?.[1]) {
					content = chunk[0][0][0][0][0][0][0][1]
					foundPath = "chunk[0][0][0][0][0][0][0][1]"
				}
				// Pattern 2: Alternative nesting
				else if (chunk?.[0]?.[0]?.[0]?.[0]?.[0]?.[0]?.[0]?.[0]?.[1]) {
					content = chunk[0][0][0][0][0][0][0][0][1]
					foundPath = "chunk[0][0][0][0][0][0][0][0][1]"
				}
				// Pattern 3: Direct access
				else if (
					chunk[0] &&
					Array.isArray(chunk[0]) &&
					chunk[0][0] &&
					Array.isArray(chunk[0][0]) &&
					chunk[0][0][0] &&
					Array.isArray(chunk[0][0][0]) &&
					chunk[0][0][0][0] &&
					Array.isArray(chunk[0][0][0][0]) &&
					chunk[0][0][0][0][0] &&
					Array.isArray(chunk[0][0][0][0][0]) &&
					chunk[0][0][0][0][0][0] &&
					Array.isArray(chunk[0][0][0][0][0][0]) &&
					chunk[0][0][0][0][0][0][0] &&
					chunk[0][0][0][0][0][0][0][1]
				) {
					content = chunk[0][0][0][0][0][0][0][1]
					foundPath = "direct access pattern"
				}

				if (content && typeof content === "string") {
					extractedChunks.push(content)
					logger.info(
						`[WebUiStudioHandler] ✅ Extracted chunk ${i} via ${foundPath}: "${content.substring(0, 100)}..."`,
					)
				} else {
					logger.debug(`[WebUiStudioHandler] No string content found in chunk ${i} via known patterns`)

					// Fallback: Recursively search for content strings, filtering out metadata
					const foundStrings = findAllStrings(chunk)
					if (foundStrings.length > 0) {
						for (const str of foundStrings) {
							if (str.trim() && isContentString(str)) {
								extractedChunks.push(str)
								logger.info(
									`[WebUiStudioHandler] ✅ Extracted via recursive search: "${str.substring(0, 100)}..."`,
								)
							} else {
								logger.debug(
									`[WebUiStudioHandler] Filtered out metadata string: "${str.substring(0, 50)}..."`,
								)
							}
						}
					} else {
						logger.debug(`[WebUiStudioHandler] No strings found in chunk ${i} even with recursive search`)
					}
				}
			} catch (e) {
				logger.debug(`[WebUiStudioHandler] Error processing chunk ${i}:`, { error: e })
				continue
			}
		}

		logger.debug(`[WebUiStudioHandler] Total extracted chunks: ${extractedChunks.length}`)
		return extractedChunks
	} catch (e) {
		logger.error("[WebUiStudioHandler] Failed to parse GenerateContent response", {
			error: e,
			jsonString: jsonString.substring(0, 200) + "...",
		})
		return []
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
