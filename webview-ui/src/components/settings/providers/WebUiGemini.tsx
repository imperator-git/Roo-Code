// webview-ui/src/components/settings/providers/WebUiGemini.tsx
import React, { useCallback } from "react"
import { VSCodeTextField, VSCodeDivider } from "@vscode/webview-ui-toolkit/react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { ProviderSettings } from "@roo/shared/api"
import { inputEventTransform } from "../transforms"

// Define Props explicitly for type safety and clarity
type WebUiGeminiProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const WebUiGemini = ({ apiConfiguration, setApiConfigurationField }: WebUiGeminiProps) => {
	const { t } = useAppTranslation()

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	const toNumberTransform = (event: any): number | undefined => {
		// Changed Event to any
		const value = event.target?.value // event.target might not always be HTMLInputElement
		if (typeof value === "string") {
			if (value.trim() === "") {
				return undefined
			}
			const num = Number(value)
			return isNaN(num) ? undefined : num
		}
		return undefined
	}

	return (
		<div className="flex flex-col space-y-4">
			<div>
				<VSCodeTextField
					value={apiConfiguration.webUiGeminiBaseUrl || ""}
					type="text" // Corrected: was "url" implied, but "text" is safer and standard
					className="w-full"
					onInput={handleInputChange("webUiGeminiBaseUrl")} // Uses default (inputEventTransform)
				>
					<label className="block font-medium mb-1">{t("settings:providers.webUiGemini.baseUrlLabel")}</label>
				</VSCodeTextField>
				<p className="text-xs text-vscode-descriptionForeground mt-1">
					{t("settings:providers.webUiGemini.baseUrlDescription")}
				</p>
			</div>

			<div>
				<VSCodeTextField
					value={apiConfiguration.webUiGeminiDiscoveryPort?.toString() || ""}
					type="text" // Corrected: Was "number"
					className="w-full"
					onInput={handleInputChange("webUiGeminiDiscoveryPort", toNumberTransform)}>
					<label className="block font-medium mb-1">
						{t("settings:providers.webUiGemini.discoveryPortLabel")}
					</label>
				</VSCodeTextField>
				<p className="text-xs text-vscode-descriptionForeground mt-1">
					{t("settings:providers.webUiGemini.discoveryPortDescription")}
				</p>
			</div>

			<div>
				<VSCodeTextField
					value={apiConfiguration.webUiGeminiPuppeteerTimeout?.toString() || ""}
					type="text" // Corrected: Was "number"
					className="w-full"
					onInput={handleInputChange("webUiGeminiPuppeteerTimeout", toNumberTransform)}>
					<label className="block font-medium mb-1">
						{t("settings:providers.webUiGemini.puppeteerTimeoutLabel")}
					</label>
				</VSCodeTextField>
				<p className="text-xs text-vscode-descriptionForeground mt-1">
					{t("settings:providers.webUiGemini.puppeteerTimeoutDescription")}
				</p>
			</div>

			<VSCodeDivider className="my-2" />

			<div className="text-sm">
				<h4 className="font-medium mb-1">{t("settings:providers.webUiGemini.securityTitle")}</h4>
				<p className="text-xs text-vscode-descriptionForeground">
					{t("settings:providers.webUiGemini.securityNote1")}
				</p>
				<p className="text-xs text-vscode-descriptionForeground">
					{t("settings:providers.webUiGemini.securityNote2")}
				</p>
				<p className="text-xs text-vscode-descriptionForeground">
					{t("settings:providers.webUiGemini.securityNote3")}
				</p>
			</div>

			<div className="text-sm">
				<h4 className="font-medium mb-1">{t("settings:providers.webUiGemini.limitationsTitle")}</h4>
				<ul className="list-disc list-inside text-xs text-vscode-descriptionForeground space-y-1">
					<li>{t("settings:providers.webUiGemini.limitation1")}</li>
					<li>{t("settings:providers.webUiGemini.limitation2")}</li>
					<li>{t("settings:providers.webUiGemini.limitation3")}</li>
					<li>{t("settings:providers.webUiGemini.limitation4")}</li>
					<li>{t("settings:providers.webUiGemini.limitation5")}</li>
				</ul>
			</div>
			<VSCodeDivider className="my-2" />
			<p className="text-xs text-vscode-descriptionForeground">{t("settings:providers.webUiGemini.note")}</p>
		</div>
	)
}
