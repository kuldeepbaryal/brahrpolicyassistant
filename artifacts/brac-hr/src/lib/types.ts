export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export interface Citation {
  title: string;
  uri: string;
  snippet: string;
}

export interface AnswerResult {
  answerText: string;
  citations: Citation[];
  relatedQuestions: string[];
  /** Discovery Engine session resource name, for multi-turn follow-ups. */
  sessionName: string | null;
  /** True when the engine could not ground an answer in the HR docs. */
  noResults: boolean;
  fromCache?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  relatedQuestions?: string[];
  createdAt: number; // epoch millis
  feedback?: "up" | "down" | null;
  /** Set on assistant messages when the engine found nothing in the HR docs. */
  noResults?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Discovery Engine session resource name backing this conversation. */
  engineSessionName: string | null;
}
