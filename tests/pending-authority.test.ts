import assert from "node:assert/strict";
import { test } from "node:test";
import { findPendingToolCall } from "../src/core/pending.ts";
import { danglingQuestionOf, newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";
import { inputAppends } from "../src/core/input-events.ts";
import { projectView } from "../src/core/view.ts";

function assistant(id: string, ...calls: string[]): LhMessage {
	return { id, role: "assistant", content: calls.map(id => ({ type: "toolCall", id, name: "quiz", arguments: { question: id } })), stopReason: "toolUse", timestamp: 1 } as LhMessage;
}

function pending(messages: LhMessage[], view = projectView(messages)) {
	return findPendingToolCall(view, danglingQuestionOf(messages)?.toolCallId ?? null);
}

test("a later assistant question supersedes an unanswered question in the same projected group", () => {
	const messages = [assistant("old", "old-question"), assistant("new", "new-question")];
	assert.equal(projectView(messages).length, 1, "the view merges both assistant boundaries");
	const question = pending(messages)!;
	assert.equal(question.toolCallId, "new-question");
	assert.doesNotThrow(() => inputAppends({ messages }, { type: "answer", toolCallId: question.toolCallId, answer: { kind: "quiz", answers: [], dontKnow: true } as never }));
});

test("the newest assistant's parallel questions retain call order and never revive older questions", () => {
	const messages = [assistant("old", "old-question"), assistant("new", "first", "second")];
	assert.equal(pending(messages)?.toolCallId, "first");
	messages.push({ ...newAnswerResult("first", "quiz", { kind: "quiz", answers: [], dontKnow: true } as never), id: "answer-first" });
	assert.equal(pending(messages)?.toolCallId, "second");
	messages.push({ ...newAnswerResult("second", "quiz", { kind: "quiz", answers: [], dontKnow: true } as never), id: "answer-second" });
	assert.equal(pending(messages), null);
});

test("the authoritative question still waits for projected input validation", () => {
	const messages = [assistant("old", "old-question"), assistant("new", "new-question")];
	const view = projectView(messages);
	for (const message of view) for (const part of message.parts) {
		if (part.type === "tool-quiz" && part.toolCallId === "new-question") part.state = "input-streaming";
	}
	assert.equal(pending(messages, view), null);
});
