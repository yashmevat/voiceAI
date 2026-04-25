(() => {
	const SPELLCHECK_API = "/api/spellcheck";
	const pendingByField = new WeakMap();

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
				body: JSON.stringify({ text: rawValue })
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

	document.addEventListener("input", (event) => {
		const element = event.target;
		if (!canAutoCorrect(element)) {
			return;
		}

		if (!endsWithSpace(element.value)) {
			return;
		}

		spellcheckField(element);
	});
})();
