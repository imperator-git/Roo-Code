// webview-ui/src/components/settings/providers/WebUiStudio.tsx
import React, { useCallback } from "react"
import { VSCodeTextField, VSCodeTextArea, VSCodeDivider } from "@vscode/webview-ui-toolkit/react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { type ProviderSettings } from "@roo-code/types"
import { inputEventTransform } from "../transforms"

// Define Props explicitly for type safety and clarity
type WebUiStudioProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const WebUiStudio = ({ apiConfiguration, setApiConfigurationField }: WebUiStudioProps) => {
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
		const value = event.target?.value
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
					value={apiConfiguration.webUiStudioBaseUrl || ""}
					type="text"
					className="w-full"
					onInput={handleInputChange("webUiStudioBaseUrl")}>
					<label className="block font-medium mb-1">{t("settings:providers.webUiStudio.baseUrlLabel")}</label>
				</VSCodeTextField>
				<p className="text-xs text-vscode-descriptionForeground mt-1">
					{t("settings:providers.webUiStudio.baseUrlDescription")}
				</p>
			</div>

			<div>
				<VSCodeTextField
					value={apiConfiguration.webUiStudioDiscoveryPort?.toString() || ""}
					type="text"
					className="w-full"
					onInput={handleInputChange("webUiStudioDiscoveryPort", toNumberTransform)}>
					<label className="block font-medium mb-1">
						{t("settings:providers.webUiStudio.discoveryPortLabel")}
					</label>
				</VSCodeTextField>
				<p className="text-xs text-vscode-descriptionForeground mt-1">
					{t("settings:providers.webUiStudio.discoveryPortDescription")}
				</p>
			</div>

			<div>
				<VSCodeTextField
					value={apiConfiguration.webUiStudioPuppeteerTimeout?.toString() || ""}
					type="text"
					className="w-full"
					onInput={handleInputChange("webUiStudioPuppeteerTimeout", toNumberTransform)}>
					<label className="block font-medium mb-1">
						{t("settings:providers.webUiStudio.puppeteerTimeoutLabel")}
					</label>
				</VSCodeTextField>
				<p className="text-xs text-vscode-descriptionForeground mt-1">
					{t("settings:providers.webUiStudio.puppeteerTimeoutDescription")}
				</p>
			</div>

			<div>
				<VSCodeTextArea
					value={apiConfiguration.webUiStudioRegenerationPrompt || ""}
					className="w-full"
					onInput={handleInputChange("webUiStudioRegenerationPrompt")}
					rows={2}>
					<label className="block font-medium mb-1">
						{t("settings:providers.webUiStudio.regenerationPromptLabel")}
					</label>
				</VSCodeTextArea>
				<p className="text-xs text-vscode-descriptionForeground mt-1">
					{t("settings:providers.webUiStudio.regenerationPromptDescription")}
				</p>
			</div>

			<div>
				<VSCodeTextArea
					value={apiConfiguration.webUiStudioMalformedTokenList || ""}
					className="w-full"
					onInput={handleInputChange("webUiStudioMalformedTokenList")}
					rows={2}>
					<label className="block font-medium mb-1">
						{t("settings:providers.webUiStudio.malformedTokenListLabel")}
					</label>
				</VSCodeTextArea>
				<p className="text-xs text-vscode-descriptionForeground mt-1">
					{t("settings:providers.webUiStudio.malformedTokenListDescription")}
				</p>
			</div>

			<VSCodeDivider className="my-2" />

			<div className="text-sm">
				<h4 className="font-medium mb-1">{t("settings:providers.webUiStudio.securityTitle")}</h4>
				<p className="text-xs text-vscode-descriptionForeground">
					{t("settings:providers.webUiStudio.securityNote1")}
				</p>
				<p className="text-xs text-vscode-descriptionForeground">
					{t("settings:providers.webUiStudio.securityNote2")}
				</p>
				<p className="text-xs text-vscode-descriptionForeground">
					{t("settings:providers.webUiStudio.securityNote3")}
				</p>
			</div>

			<div className="text-sm">
				<h4 className="font-medium mb-1">{t("settings:providers.webUiStudio.limitationsTitle")}</h4>
				<ul className="list-disc list-inside text-xs text-vscode-descriptionForeground space-y-1">
					<li>{t("settings:providers.webUiStudio.limitation1")}</li>
					<li>{t("settings:providers.webUiStudio.limitation2")}</li>
					<li>{t("settings:providers.webUiStudio.limitation3")}</li>
					<li>{t("settings:providers.webUiStudio.limitation4")}</li>
					<li>{t("settings:providers.webUiStudio.limitation5")}</li>
				</ul>
			</div>
			<VSCodeDivider className="my-2" />
			<p className="text-xs text-vscode-descriptionForeground">{t("settings:providers.webUiStudio.note")}</p>
		</div>
	)
}
