import { createClient } from "@/lib/client";
import { BACKEND_URL } from "@/lib/config";
import type { User } from "@supabase/supabase-js";
import axios from "axios";
import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router";
import { Search, Plus, LogOut, MessageSquare, Compass, Globe, Sparkles, Loader2, Menu, X, User as UserIcon, Paperclip } from "lucide-react";

const supabase = createClient();

interface Conversation {
    id: string;
    title: string;
    slug: string;
}

interface Message {
    id?: string;
    role: "User" | "Assistant";
    content: string;
    attachments?: string[];
}

interface UploadedAttachment {
    name: string;
    mediaType: string;
    data: string;
}

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_SIZE = 2 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE = 15 * 1024 * 1024;

function getAttachmentMediaType(file: File) {
    const extension = file.name.split(".").pop()?.toLowerCase();
    const inferredTypes: Record<string, string> = {
        csv: "text/csv",
        json: "application/json",
        md: "text/markdown",
        pdf: "application/pdf",
        txt: "text/plain",
    };
    const mediaType = file.type || inferredTypes[extension ?? ""] || "";
    if (
        mediaType.startsWith("text/") ||
        mediaType === "application/json" ||
        mediaType === "application/xml" ||
        mediaType === "application/pdf" ||
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)
    ) {
        return mediaType;
    }
    return null;
}

export default function Dashboard() {
    const navigate = useNavigate();
    const [user, setUser] = useState<User | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [inputQuery, setInputQuery] = useState("");
    const [isStreaming, setIsStreaming] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(false); // Mobile sidebar toggle state
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [attachmentError, setAttachmentError] = useState<string | null>(null);
    const [requestError, setRequestError] = useState<string | null>(null);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Auto-scroll chat to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, isStreaming]);

    // Auth Guard
    useEffect(() => {
        async function getUser() {
            try {
                const { data, error } = await supabase.auth.getUser();
                if (error) throw error;
                if (data.user) {
                    setUser(data.user);
                } else {
                    navigate("/auth");
                }
            } catch (error) {
                console.error("Authentication check failed:", error);
                navigate("/auth", {
                    state: { authError: "Unable to verify your sign-in. Check your connection and try again." },
                    replace: true,
                });
            }
        }
        getUser();
    }, [navigate]);

    // Fetch Conversation Sidebar List
    async function fetchConversations() {
        if (!user) return;
        try {
            const { data: { session } } = await supabase.auth.getSession();
            const response = await axios.get(`${BACKEND_URL}/conversations`, {
                headers: { Authorization: session?.access_token },
            });
            setConversations(response.data);
        } catch (err) {
            console.error("Error fetching history:", err);
        }
    }

    useEffect(() => {
        fetchConversations();
    }, [user]);

    // Load a single conversation when clicked from sidebar
    async function loadConversation(id: string) {
        if (isStreaming) return;
        try {
            setActiveConversationId(id);
            setIsSidebarOpen(false); // Close menu overlay implicitly on mobile tap selection
            const { data: { session } } = await supabase.auth.getSession();
            const response = await axios.get(`${BACKEND_URL}/conversations/${id}`, {
                headers: { Authorization: session?.access_token },
            });
            if (response.data?.conversation?.messages) {
                setMessages(response.data.conversation.messages);
            }
        } catch (err) {
            console.error("Error loading conversation:", err);
        }
    }

    function handleSearchSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!inputQuery.trim() && selectedFiles.length === 0) return;

        const targetQuery = inputQuery;
        const targetFiles = selectedFiles;
        setInputQuery(""); // Instantly clear input for better UX
        setAttachmentError(null);
        executeSearchPipeline(targetQuery, targetFiles);
    }

    function startNewChat() {
        if (isStreaming) return;
        setActiveConversationId(null);
        setMessages([]);
        setInputQuery("");
        setSelectedFiles([]);
        setAttachmentError(null);
        setRequestError(null);
        setIsSidebarOpen(false); // Close overlay drawer menu container on action execution
    }

    function handleAttachmentSelection(event: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (!files.length) return;

        const nextFiles = [...selectedFiles];
        for (const file of files) {
            const mediaType = getAttachmentMediaType(file);
            if (!mediaType) {
                setAttachmentError(`${file.name} is not a supported file type.`);
                return;
            }
            const sizeLimit = mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/xml"
                ? MAX_TEXT_ATTACHMENT_SIZE
                : MAX_ATTACHMENT_SIZE;
            if (file.size === 0 || file.size > sizeLimit) {
                setAttachmentError(`${file.name} exceeds the ${sizeLimit / (1024 * 1024)} MB limit or is empty.`);
                return;
            }
            if (nextFiles.some((selected) => selected.name === file.name && selected.size === file.size && selected.lastModified === file.lastModified)) {
                continue;
            }
            if (nextFiles.length >= MAX_ATTACHMENTS) {
                setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
                return;
            }
            if (nextFiles.reduce((total, selected) => total + selected.size, 0) + file.size > MAX_TOTAL_ATTACHMENT_SIZE) {
                setAttachmentError("Attachments must total 15 MB or less.");
                return;
            }
            nextFiles.push(file);
        }

        setSelectedFiles(nextFiles);
        setAttachmentError(null);
        setRequestError(null);
    }

    function renderAttachmentControls() {
        return (
            <>
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,application/json,application/xml"
                    onChange={handleAttachmentSelection}
                    disabled={isStreaming}
                    className="hidden"
                />
                {selectedFiles.length > 0 && (
                    <div className="flex flex-wrap gap-2 px-1 pb-2">
                        {selectedFiles.map((file) => (
                            <span key={`${file.name}-${file.lastModified}`} className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-300">
                                <Paperclip className="h-3 w-3 text-teal-400" />
                                <span className="max-w-40 truncate">{file.name}</span>
                                <button
                                    type="button"
                                    aria-label={`Remove ${file.name}`}
                                    disabled={isStreaming}
                                    onClick={() => setSelectedFiles((current) => current.filter((selected) => selected !== file))}
                                    className="text-zinc-500 hover:text-zinc-200"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </span>
                        ))}
                    </div>
                )}
                {attachmentError && <p role="alert" className="px-1 pb-2 text-xs text-red-400">{attachmentError}</p>}
                {requestError && <p role="alert" className="px-1 pb-2 text-xs text-red-400">{requestError}</p>}
            </>
        );
    }

    // Utility to split the AI stream content away from raw injected JSON tags
    function renderMessageContent(content: string) {
        if (!content) return null;

        // 1. Separate web search sources if present
        let textToParse = content;
        let rawSources = "";
        if (content.includes("<SOURCES>")) {
            const splitSources = content.split("<SOURCES>");
            textToParse = splitSources[0] || "";
            rawSources = splitSources[1] || "";
        }

        // 2. Extract the core answer text from between the <ANSWER> tags
        let mainAnswer = textToParse;
        const answerMatch = textToParse.match(/<ANSWER>([\s\S]*?)<\/ANSWER>/);
        if (answerMatch && answerMatch[1]) {
            mainAnswer = answerMatch[1].trim();
        } else {
            // Fallback during active streaming before tags are closed
            mainAnswer = textToParse
                .replace(/<ANSWER>/g, "")
                .replace(/<\/ANSWER>/g, "")
                .split(/<FOLLOW_UPS>/)[0] || "";
        }

        // 3. Extract individual follow-up questions from the <FOLLOW_UPS> block
        const followUpQuestions: string[] = [];
        const followUpsMatch = textToParse.match(/<FOLLOW_UPS>([\s\S]*?)<\/FOLLOW_UPS>/);

        if (followUpsMatch && followUpsMatch[1]) {
            const questionMatches = followUpsMatch[1].matchAll(/<question>([\s\S]*?)<\/question>/g);
            for (const match of questionMatches) {
                if (match[1] && match[1].trim()) {
                    followUpQuestions.push(match[1].trim());
                }
            }
        }

        // 4. Parse your web sources JSON block safely
        let parsedSources: { url: string }[] = [];
        if (rawSources) {
            const cleanSourcesJson = rawSources.replace("</SOURCES>", "").trim();
            if (cleanSourcesJson) {
                try {
                    parsedSources = JSON.parse(cleanSourcesJson);
                } catch (e) {
                    // Stream chunk is partial JSON
                }
            }
        }

        return (
            <div className="space-y-6">
                {/* Clean Main Text Body */}
                <p className="text-zinc-300 leading-relaxed whitespace-pre-wrap">{mainAnswer.trim()}</p>

                {/* Render Web Sources Grid if available */}
                {parsedSources.length > 0 && (
                    <div className="pt-4 border-t border-zinc-900">
                        <div className="flex items-center gap-1.5 text-xs text-zinc-500 font-medium mb-2.5 uppercase tracking-wider">
                            <Globe className="w-3.5 h-3.5 text-teal-500" />
                            <span>Sources Explored</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {parsedSources.map((source, idx) => {
                                if (!source?.url) return null;
                                let domain = source.url;
                                try { domain = new URL(source.url).hostname; } catch (e) { }
                                return (
                                    <a
                                        key={idx}
                                        href={source.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-xs bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 px-2.5 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 transition flex items-center gap-2 max-w-[220px]"
                                    >
                                        <span className="bg-zinc-800 text-zinc-400 w-4 h-4 rounded-md flex items-center justify-center text-[10px] shrink-0 font-mono border border-zinc-700/50">
                                            {idx + 1}
                                        </span>
                                        <span className="truncate">{domain}</span>
                                    </a>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Render Suggested Follow Ups as Interactive Elements */}
                {followUpQuestions.length > 0 && !isStreaming && (
                    <div className="pt-4 border-t border-zinc-900 space-y-2">
                        <div className="flex items-center gap-1.5 text-xs text-zinc-500 font-medium mb-1 uppercase tracking-wider">
                            <Sparkles className="w-3.5 h-3.5 text-teal-500" />
                            <span>Related Questions</span>
                        </div>
                        <div className="flex flex-col gap-1.5 items-stretch">
                            {followUpQuestions.map((question, idx) => (
                                <button
                                    key={idx}
                                    onClick={() => handleFollowUpClick(question)}
                                    className="text-left text-xs text-zinc-400 hover:text-teal-400 bg-zinc-900/40 hover:bg-zinc-900 border border-zinc-900 hover:border-zinc-800/80 px-3 py-2.5 rounded-lg transition-all duration-200 flex items-center justify-between group"
                                >
                                    <span>{question}</span>
                                    <span className="text-zinc-600 group-hover:text-teal-500 transition-colors pl-2">→</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // Abstracted execution function for handling text queries
    async function executeSearchPipeline(queryText: string, files: File[] = []) {
        if ((!queryText.trim() && files.length === 0) || isStreaming) return;

        setIsStreaming(true);
        setRequestError(null);
        const isFollowUp = !!activeConversationId;
        const endpoint = isFollowUp ? `${BACKEND_URL}/ask-with-followup-rest` : `${BACKEND_URL}/ask-rest`;

        try {
            const attachments: UploadedAttachment[] = await Promise.all(files.map(async (file) => {
                const mediaType = getAttachmentMediaType(file);
                if (!mediaType) throw new Error(`${file.name} is not a supported file type.`);
                const isText = mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/xml";
                const data = isText
                    ? await file.text()
                    : await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(`Could not read ${file.name}.`));
                        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
                        reader.readAsDataURL(file);
                    });
                return { name: file.name, mediaType, data };
            }));
            const displayQuery = queryText.trim() || "Please analyze the attached file(s).";
            setMessages((prev) => [...prev, {
                role: "User",
                content: displayQuery,
                attachments: files.map((file) => file.name),
            }, { role: "Assistant", content: "" }]);

            const { data: { session } } = await supabase.auth.getSession();
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: session?.access_token || "",
                },
                body: JSON.stringify({
                    query: queryText,
                    conversationId: activeConversationId || undefined,
                    attachments,
                }),
            });

            if (!response.ok) {
                const errorBody = await response.text();
                let message = errorBody || `Request failed (${response.status}).`;
                try {
                    const parsed = JSON.parse(errorBody);
                    const summary = parsed.error || parsed.message;
                    const details = typeof parsed.details === "string" ? parsed.details : "";
                    message = [summary, details].filter(Boolean).join(": ") || message;
                } catch {
                    // Keep the response body as the error message when it is not JSON.
                }
                throw new Error(message);
            }
            if (!response.body) throw new Error("The server did not start a response stream.");
            setSelectedFiles([]);

            if (!isFollowUp) {
                const headerConvId = response.headers.get("x-conversation-id");
                if (headerConvId) setActiveConversationId(headerConvId);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let accumulatedText = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                accumulatedText += chunk;

                setMessages((prev) => {
                    const updated = [...prev];
                    if (updated.length > 0) {
                        updated[updated.length - 1] = {
                            role: "Assistant",
                            content: accumulatedText,
                        };
                    }
                    return updated;
                });
            }

            if (!isFollowUp) fetchConversations();

        } catch (error) {
            console.error("Pipeline failure:", error);
            setRequestError(error instanceof Error ? error.message : "The request failed.");
            setMessages((prev) => {
                const lastMessage = prev[prev.length - 1];
                return lastMessage?.role === "Assistant" && !lastMessage.content ? prev.slice(0, -1) : prev;
            });
        } finally {
            setIsStreaming(false);
        }
    }

    // Handler wired up directly to your interactive follow-up list items
    function handleFollowUpClick(question: string) {
        executeSearchPipeline(question);
    }

    return (
        <div className="flex h-screen bg-zinc-950 text-zinc-50 antialiased font-sans relative overflow-hidden">
            
            {/* Mobile Sidebar Backdrop overlay shadow */}
            {isSidebarOpen && (
                <div 
                    onClick={() => setIsSidebarOpen(false)}
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden transition-opacity duration-300"
                />
            )}

            {/* Sidebar Section — Handles clean layout toggle logic */}
            <aside className={`
                fixed inset-y-0 left-0 w-64 border-r border-zinc-900 bg-zinc-950 flex flex-col justify-between shrink-0 z-50
                transition-transform duration-300 transform md:relative md:translate-x-0 md:bg-zinc-900/30
                ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}
            `}>
                <div className="p-4 flex flex-col flex-1 min-h-0">
                    {/* Header Logo + Mobile X Close action */}
                    <div className="flex items-center justify-between gap-2 mb-4 md:mb-0">
                        <span className="text-xs font-semibold text-zinc-400 tracking-wider uppercase md:hidden">Navigation Menu</span>
                        <button 
                            onClick={() => setIsSidebarOpen(false)}
                            className="p-1 text-zinc-400 hover:text-zinc-200 bg-zinc-900 rounded-md md:hidden border border-zinc-800"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Logo / New Chat Button */}
                    <button
                        onClick={startNewChat}
                        className="w-full flex items-center justify-between px-3 py-2.5 bg-zinc-900 hover:bg-zinc-800/80 border border-zinc-800 hover:border-zinc-700 rounded-lg text-sm font-medium transition shadow-sm group text-zinc-200"
                    >
                        <div className="flex items-center gap-2">
                            <Sparkles className="w-4 h-4 text-teal-400 group-hover:rotate-12 transition-transform" />
                            <span>New Thread</span>
                        </div>
                        <Plus className="w-4 h-4 text-zinc-400" />
                    </button>

                    {/* History Item list */}
                    <div className="mt-6 flex-1 overflow-y-auto space-y-1 pr-1 
                            [&::-webkit-scrollbar]:w-1 
                            [&::-webkit-scrollbar-track]:bg-transparent 
                            [&::-webkit-scrollbar-thumb]:bg-zinc-800 
                            hover:[&::-webkit-scrollbar-thumb]:bg-zinc-700 
                            [&::-webkit-scrollbar-thumb]:rounded-full"
                    >
                        <div className="px-3 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Recent Threads</div>
                        {conversations.length === 0 ? (
                            <div className="text-xs text-zinc-600 px-3 py-2 italic">No search history yet</div>
                        ) : (
                            conversations.map((conv) => (
                                <button
                                    key={conv.id}
                                    onClick={() => loadConversation(conv.id)}
                                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left truncate transition group ${activeConversationId === conv.id
                                        ? "bg-zinc-900 text-zinc-100 border border-zinc-800"
                                        : "text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200"
                                        }`}
                                >
                                    <MessageSquare className={`w-3.5 h-3.5 shrink-0 ${activeConversationId === conv.id ? 'text-teal-400' : 'text-zinc-500'}`} />
                                    <span className="truncate flex-1">{conv.title}</span>
                                </button>
                            ))
                        )}
                    </div>
                </div>

                {/* User Account / Footer */}
                {user && (
                    <div className="p-4 border-t border-zinc-900 bg-zinc-950/40 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                            <div className="w-7 h-7 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400 shrink-0 border border-zinc-700">
                                <UserIcon className="w-3.5 h-3.5" />
                            </div>
                            <span className="text-xs text-zinc-400 truncate max-w-[120px] font-medium">{user.email}</span>
                        </div>
                        <button
                            onClick={() => { supabase.auth.signOut(); navigate("/auth"); }}
                            className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-900 rounded-md transition"
                            title="Log out"
                        >
                            <LogOut className="w-4 h-4" />
                        </button>
                    </div>
                )}
            </aside>

            {/* Main Container workspace */}
            <main className="flex-1 flex flex-col bg-zinc-950 min-w-0 relative">
                
                {/* Mobile Top App Header Bar */}
                <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md md:hidden sticky top-0 z-30">
                    <button 
                        onClick={() => setIsSidebarOpen(true)}
                        className="p-1.5 text-zinc-400 hover:text-zinc-200 bg-zinc-900 border border-zinc-800 rounded-lg transition"
                    >
                        <Menu className="w-4 h-4" />
                    </button>
                    <div className="text-xs font-medium text-zinc-300 flex items-center gap-1">
                        <Sparkles className="w-3.5 h-3.5 text-teal-400" />
                        <span>Research Engine</span>
                    </div>
                    <button 
                        onClick={startNewChat}
                        className="p-1.5 text-zinc-400 hover:text-zinc-200 bg-zinc-900 border border-zinc-800 rounded-lg transition"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </header>

                {/* Dynamic Inner Container */}
                {messages.length === 0 ? (

                    /* VIEW A: Empty / Landing Layout */
                    <div className="flex-1 flex flex-col items-center justify-center px-4 max-w-2xl mx-auto w-full transition-all">
                        <div className="text-center mb-6 md:mb-8 space-y-2">
                            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-zinc-100 flex items-center justify-center gap-2">
                                Where knowledge begins
                            </h1>
                            <p className="text-zinc-400 text-xs md:text-sm max-w-md mx-auto">Ask a question and search the web engine comprehensively in real-time.</p>
                        </div>

                        {/* Central Main Input Box */}
                        <form onSubmit={handleSearchSubmit} className="w-full bg-zinc-900/60 border border-zinc-800 rounded-xl p-2 md:p-2.5 shadow-xl focus-within:border-zinc-700 focus-within:ring-1 focus-within:ring-zinc-700 transition">
                            <textarea
                                value={inputQuery}
                                onChange={(e) => setInputQuery(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        handleSearchSubmit(e);
                                    }
                                }}
                                placeholder="Ask anything..."
                                rows={3}
                                className="w-full bg-transparent outline-none resize-none text-zinc-200 placeholder-zinc-500 text-sm px-2 pt-1"
                            />
                            {renderAttachmentControls()}
                            <div className="flex items-center justify-between border-t border-zinc-800/80 pt-2 px-1">
                                <div className="flex items-center gap-1.5 text-[11px] md:text-xs text-zinc-500 bg-zinc-950 px-2 py-1 rounded-md border border-zinc-800/60">
                                    <Compass className="w-3.5 h-3.5 text-zinc-400" />
                                    <span>Pro Search Depth Enabled</span>
                                </div>
                                <div><button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    aria-label="Attach files"
                                    title="Attach images, PDFs, or text files"
                                    disabled={isStreaming}
                                    className="p-2 text-zinc-400 hover:text-zinc-200 rounded-lg transition"
                                >
                                    <Paperclip className="w-4 h-4" />
                                </button>
                                <button
                                    type="submit"
                                    disabled={!inputQuery.trim() && selectedFiles.length === 0}
                                    className="p-2 bg-zinc-100 hover:bg-zinc-200 disabled:bg-zinc-800 text-zinc-950 disabled:text-zinc-600 rounded-lg transition"
                                >
                                    <Search className="w-4 h-4" />
                                </button></div>
                            </div>
                        </form>
                    </div>
                ) : (

                    /* VIEW B: Active Chat / Thread View */
                    <div className="flex-1 flex flex-col min-h-0">
                        {/* Scrollable Conversation Stream */}
                        <div className="flex-1 overflow-y-auto px-4 py-6 md:py-8 space-y-6 md:space-y-8 max-w-3xl mx-auto w-full
                              [&::-webkit-scrollbar]:w-1.5
                              [&::-webkit-scrollbar-track]:bg-transparent
                              [&::-webkit-scrollbar-thumb]:bg-zinc-800/80
                              hover:[&::-webkit-scrollbar-thumb]:bg-zinc-700
                              [&::-webkit-scrollbar-thumb]:rounded-full"
                        >
                            {messages.map((msg, index) => (
                                <div
                                    key={index}
                                    className={`flex gap-3 md:gap-4 ${msg.role === "User" ? "justify-end" : "justify-start"}`}
                                >
                                    {/* Assistant Avatar Row Badge */}
                                    {msg.role === "Assistant" && (
                                        <div className="w-6 h-6 rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 text-teal-400">
                                            <Sparkles className="w-3.5 h-3.5" />
                                        </div>
                                    )}

                                    <div className={`max-w-[90%] md:max-w-[85%] rounded-xl px-3.5 py-2.5 md:px-4 md:py-3 text-sm transition ${msg.role === "User"
                                        ? "bg-zinc-900 border border-zinc-800 text-zinc-200"
                                        : "w-full text-zinc-300 bg-transparent px-0 py-1"
                                        }`}>
                                        {msg.role === "User" ? (
                                            <>
                                                <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                                                {msg.attachments && msg.attachments.length > 0 && (
                                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                                        {msg.attachments.map((name) => (
                                                            <span key={name} className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-xs text-zinc-400">
                                                                <Paperclip className="h-3 w-3" />{name}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                            </>
                                        ) : (
                                            renderMessageContent(msg.content)
                                        )}
                                    </div>
                                </div>
                            ))}

                            {/* Explicit Streaming state Loading indicators */}
                            {isStreaming && messages[messages.length - 1]?.content === "" && (
                                <div className="flex gap-3 md:gap-4 items-center text-zinc-500 text-xs md:text-sm max-w-3xl mx-auto w-full">
                                    <div className="w-6 h-6 rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 text-teal-500">
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    </div>
                                    <span className="italic animate-pulse">Running advanced deep research queries...</span>
                                </div>
                            )}

                            <div ref={messagesEndRef} />
                        </div>

                        {/* Bottom Dynamic Sticky Context Input Field */}
                        <div className="border-t border-zinc-900/80 bg-zinc-950 px-4 py-3 md:py-4 max-w-3xl mx-auto w-full">
                            <form onSubmit={handleSearchSubmit} className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 focus-within:border-zinc-700 transition">
                                {renderAttachmentControls()}
                                <div className="flex gap-2 items-center">
                                <input
                                    type="text"
                                    value={inputQuery}
                                    disabled={isStreaming}
                                    onChange={(e) => setInputQuery(e.target.value)}
                                    placeholder="Ask a follow up question..."
                                    className="flex-1 bg-transparent text-sm outline-none text-zinc-200 placeholder-zinc-500 disabled:opacity-50 min-w-0"
                                />
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    aria-label="Attach files"
                                    title="Attach images, PDFs, or text files"
                                    disabled={isStreaming}
                                    className="p-1.5 text-zinc-400 hover:text-zinc-200 disabled:opacity-50 rounded-md transition shrink-0"
                                >
                                    <Paperclip className="w-4 h-4" />
                                </button>
                                <button
                                    type="submit"
                                    disabled={(!inputQuery.trim() && selectedFiles.length === 0) || isStreaming}
                                    className="p-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-950 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-md transition shrink-0"
                                >
                                    {isStreaming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                                </button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}