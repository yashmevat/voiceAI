(() => {
	const SPELLCHECK_API = "/api/spellcheck";
	const pendingByField = new WeakMap();
	const lastCorrectionByField = new WeakMap();
	const protectedTokensByField = new WeakMap();

	function canAutoCorrect(element) {
		if (!element) {
			return false;
		}

		const tag = element.tagName;
		if (tag === "TEXTAREA") {
			return true;
		}

		if (tag !== "INPUT") {
			return false;
		}

		const type = (element.type || "text").toLowerCase();
		return ["text", "search", "email", "url", "tel"].includes(type);
	}

	function endsWithSpace(value) {
		return /\s$/.test(value);
	}

	function getProtectedTokens(element) {
		let tokens = protectedTokensByField.get(element);
		if (!tokens) {
			tokens = new Set();
			protectedTokensByField.set(element, tokens);
		}

		return tokens;
	}

	function getLastWord(value) {
		const tokens = String(value || "").trim().split(/\s+/).filter(Boolean);
		return tokens.length ? tokens[tokens.length - 1] : "";
	}

	function escapeRegExp(value) {
		return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	function pruneProtectedTokens(element) {
		const tokens = protectedTokensByField.get(element);
		if (!tokens || tokens.size === 0) {
			return;
		}

		for (const token of [...tokens]) {
			const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(token)}(?:\\s|$)`, "i");
			if (!pattern.test(element.value)) {
				tokens.delete(token);
			}
		}
	}

	async function spellcheckField(element) {
		const rawValue = element.value;
		if (!rawValue || !endsWithSpace(rawValue)) {
			return;
		}

		const caretStart = element.selectionStart;
		const caretEnd = element.selectionEnd;
		const ticket = Symbol("spellcheck");
		pendingByField.set(element, ticket);

		try {
			const response = await fetch(SPELLCHECK_API, {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					text: rawValue,
					exemptTokens: [...getProtectedTokens(element)]
				})
			});

			if (!response.ok) {
				return;
			}

			const data = await response.json();
			if (pendingByField.get(element) !== ticket) {
				return;
			}

			if (!data?.changed || typeof data.correctedText !== "string") {
				return;
			}

			element.value = data.correctedText;
			lastCorrectionByField.set(element, {
				rawValue,
				correctedValue: data.correctedText
			});

			if (typeof caretStart === "number" && typeof caretEnd === "number") {
				const delta = data.correctedText.length - rawValue.length;
				const nextStart = Math.max(0, caretStart + delta);
				const nextEnd = Math.max(0, caretEnd + delta);
				element.setSelectionRange(nextStart, nextEnd);
			}
		} catch {
			// Ignore spellcheck errors to avoid blocking typing.
		}
	}

	document.addEventListener("keydown", (event) => {
		if (event.key !== "Backspace") {
			return;
		}

		const element = event.target;
		if (!canAutoCorrect(element)) {
			return;
		}

		const correction = lastCorrectionByField.get(element);
		if (!correction || element.value !== correction.correctedValue) {
			return;
		}

		if (element.selectionStart !== element.selectionEnd || element.selectionStart !== element.value.length) {
			return;
		}

		event.preventDefault();
		element.value = correction.rawValue;
		const caret = correction.rawValue.length;
		element.setSelectionRange(caret, caret);
			const restoredWord = getLastWord(correction.rawValue);
			if (restoredWord) {
				getProtectedTokens(element).add(restoredWord);
			}
		lastCorrectionByField.delete(element);
		pendingByField.delete(element);
	});

	document.addEventListener("input", (event) => {
		const element = event.target;
		if (!canAutoCorrect(element)) {
			return;
		}

		pruneProtectedTokens(element);

		const correction = lastCorrectionByField.get(element);
		if (correction && element.value !== correction.correctedValue) {
			lastCorrectionByField.delete(element);
		}

		if (!endsWithSpace(element.value)) {
			return;
		}

		spellcheckField(element);
	});
})();
