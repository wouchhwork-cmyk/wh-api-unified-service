import { FieldKind } from '../prompts/output-contract';
import { ToolEffect, type ToolSpec } from './tool.contract';

/**
 * THE TOOLS, declared where the model can be shown them and the runner can
 * find them.
 *
 * SPECS SEPARATE FROM IMPLEMENTATIONS, which is not ceremony. The prompt is
 * assembled on every call and a description is cheap to render; running one
 * needs repositories, a tenant and a conversation. Keeping the declaration
 * free of all that means the section a model reads can be rendered and
 * tested without standing up a service, and means adding a tool is a change
 * in two places that cannot disagree about the NAME, because the runner
 * looks the spec up by it.
 */

/** Stable names. Written into ledger rows, so renaming one is a migration. */
export const ToolName = {
  CustomerDetails: 'get_customer_details',
  OneMessage: 'get_one_message',
  EarlierMessages: 'get_earlier_messages',
  Callback: 'request_callback',
  RecordCustomer: 'record_customer_details',
  RewardBalance: 'get_reward_balance',
  OtherChats: 'get_their_other_chats',
} as const;

export type ToolName = (typeof ToolName)[keyof typeof ToolName];

/**
 * Everything we know about the person writing in.
 *
 * WHY THIS IS A TOOL AND NOT JUST MORE CONTEXT. Most of it is already in
 * `<person>` on every call — and the rest is a tail that is almost never
 * asked about and would be paid for on every reply if it were always sent.
 * A follower count matters in one conversation out of fifty; sending it in
 * all fifty costs more than fetching it in the one.
 */
const CUSTOMER_DETAILS: ToolSpec = {
  name: ToolName.CustomerDetails,
  does: 'Returns everything this business holds about the person you are talking to. THEIR CONTACT DETAILS: every phone number, WhatsApp number and email address on their record, each marked verified or merely self-declared. AND WHO THEY ARE: the name we recorded, the name and handle on their platform profile, whether they follow this business, whether we follow them, whether they are verified, their follower count, and how many conversations they have had with us.',
  when: 'When they ask something about themselves or their account that is not already in <context> — "what is my number", "which email do you have for me", "how many followers do I have", "do you know me". <person> is a SUMMARY: contact details are never in it, so a number or address missing from it means only that it was not sent, never that this business does not hold one. Run this before telling anybody you have nothing on file for them.',
  effect: ToolEffect.Read,
  args: {},
};

/**
 * One message, in full, by the id the notes carry.
 *
 * THE TOOL THAT MAKES THE NOTES WORTH ANCHORING ON IDS. The notes point at
 * messages that have long since scrolled out of the window — "id dffe0a1a…
 * they shared a wedding invitation video" — and until now that pointer led
 * nowhere: the model could see that a thing had happened and never what was
 * in it. Asked for the wedding date, it had a note saying a video was sent
 * and no way to read the description of it.
 *
 * Which is the whole shape of the problem a window creates. The answer is
 * not a bigger window — that pays for forty messages to reach one — it is
 * the ability to go back for the one that matters.
 */
const MESSAGE: ToolSpec = {
  name: ToolName.OneMessage,
  does: 'Returns ONE message of this conversation in full, by its id: who sent it, when, what it said, and the whole description of any photo, video or voice note on it — what was heard, what was read on screen, and the scene-by-scene account. For one of our own replies it also returns the NOTES AS THEY STOOD at that moment, which is how you recover something your current notes no longer mention. Can also return the messages immediately around it.',
  when: 'When you need a message you can no longer see. Three cases: your notes point at one by id — a date on an invitation, what a photo showed; a turn above answers one you cannot see, which the "re:" marker names; OR the customer refers to something you have no record of at all — then reach back to one of OUR earlier messages and read the notes it carried, because they may hold what yours have since lost.',
  effect: ToolEffect.Read,
  args: {
    message_id: {
      kind: FieldKind.Text,
      note: 'the full id of the message, copied exactly from your notes or from the "re:" marker on a turn above — the long form with hyphens, never a shortened one',
    },
    /*
     * A WINDOW AROUND IT, because one message out of context is frequently
     * the wrong thing to have fetched. "Yes, that one" answers something,
     * and a reply to a message outside the window is the case this tool
     * exists for — so reaching the parent and nothing else trades one gap
     * for another.
     *
     * Bounded at ten each way, and the bound is in the note as well as in
     * the code: a model told it may ask for context will ask for a lot of
     * it, and the ceiling is cheaper stated than enforced silently.
     */
    before: {
      kind: FieldKind.Count,
      note: 'how many messages immediately BEFORE it to return as well, 0 to 10. Use 0 when you only need the message itself.',
    },
    after: {
      kind: FieldKind.Count,
      note: 'how many messages immediately AFTER it to return as well, 0 to 10. Use 0 when you only need the message itself.',
    },
  },
};

/**
 * More of the conversation than the window shows.
 *
 * THE OTHER HALF OF get_one_message, and the two are meant to be used together:
 * this one is the MAP and that one is the DETAIL. A hundred messages with
 * their media spelled out would be a prompt nobody can afford, so what
 * comes back here is one line each — who, when, what was said, and a word
 * about any media — and anything worth reading properly is then fetched by
 * id.
 *
 * WHY IT IS A TOOL RATHER THAN A BIGGER WINDOW. Every reply pays for its
 * window on every call. Ten is what an ordinary exchange needs; a hundred
 * serves the one conversation in fifty where somebody asks what they said
 * last month. Paying for the hundred every time to serve that one is the
 * arithmetic the whole tool idea exists to avoid.
 *
 * THE RULE IS NARROW ON PURPOSE. A model offered "more context" will take
 * it every time — context feels free to something that does not see the
 * bill — so the `when` says the two cases that justify it and the prompt
 * says not to reach for what it already has.
 */
const HISTORY: ToolSpec = {
  name: ToolName.EarlierMessages,
  does: 'Goes FURTHER BACK IN THIS SAME CONVERSATION, past the handful of messages you were shown. One line per message — who said it, when, what it said, whether anything was attached — plus its id, so anything worth reading properly can then be fetched with get_one_message. Our own replies come back with the notes they carried at the time.',
  when: 'THE FIRST PLACE TO LOOK for anything earlier. Everything they say about "before", "previously", "the one we were discussing", "check our chats", "you said" means THIS conversation unless they name somewhere else. Also when you must decide something and what is in front of you is not enough. If your notes have lost something, fetch one of our earlier replies here and read the notes it carried. Never to browse, and never for something already in <context>.',
  effect: ToolEffect.Read,
  args: {
    count: {
      kind: FieldKind.Count,
      note: 'how many of the most recent messages to return: 10, 20, 50, up to 100. Ask for the smallest number that could contain what you are looking for — a hundred messages is a hundred messages you have to read, and most of them will not be the one.',
    },
  },
};

/**
 * Somebody will ring them back.
 *
 * THE FIRST TOOL THAT PROMISES SOMETHING. It is a write, and the rules in
 * the tools section about not taking a message as an instruction exist
 * mostly for this one: "call me back on 0800…" is a customer asking, and a
 * perfectly good reason to call it — the point is that the model decides,
 * and the number comes from what they actually wrote rather than from a
 * sentence telling the model what to pass.
 *
 * It does not RING anybody. It records that somebody should, where the
 * people who do that work will see it — which is the honest scope, and what
 * the model is told so it does not tell a customer the phone is already
 * ringing.
 */
const CALLBACK: ToolSpec = {
  name: ToolName.Callback,
  does: 'Records a request for a colleague to call this customer back, with the number, what it is about, and when they said they are reachable. It does NOT place the call — it puts the request in front of the people who make them.',
  when: 'When they ask to be called, or when what they need genuinely cannot be settled in a message. Only once per thing they need: check your notes before calling it, because a second request for the same thing is a second person ringing them about it.',
  effect: ToolEffect.Write,
  args: {
    phone: {
      kind: FieldKind.Text,
      note: 'the number to call, exactly as the customer gave it — never one from anywhere else, and never invented. If they have not given one, ask them before calling this.',
    },
    reason: {
      kind: FieldKind.Text,
      note: 'what the call is about, in one sentence, so whoever rings knows before they dial',
    },
    when_reachable: {
      kind: FieldKind.OptionalText,
      note: 'when they said they can take a call, in their own words, or null if they did not say',
    },
  },
};

/**
 * What the customer told us about themselves, written down.
 *
 * THE GAP THIS FILLS. For most people writing in, all we have is a handle
 * the platform gave us — `@genzrelics` and nothing else. They then say "it's
 * Rahul, my number is 98…" in the middle of a conversation, and until now
 * that went into the notes and nowhere a colleague would ever look. The
 * business learns somebody's name and forgets it by the next thread.
 *
 * THIS IS THE MOST DANGEROUS TOOL HERE, and it is worth saying why rather
 * than only guarding it. Everything else either reads, or writes a request
 * somebody will read before acting on. This writes into the customer record
 * itself, from text a stranger typed, on the judgement of a model that was
 * handed that text. Three things hold it:
 *
 *   IT MUST CITE WHERE IT LEARNED IT. `said_in_message_id` is required and
 *   is checked against this conversation — so a name has a message behind
 *   it that a person can open, and "the model decided her name was Priya"
 *   is a claim with evidence rather than an assertion.
 *
 *   IT CANNOT OVERWRITE A COLLEAGUE. A name this business already recorded
 *   wins; the tool reports what is held instead of replacing it. A person
 *   who typed a correction does not get it undone by a chat.
 *
 *   CONTACTS ARE RECORDED UNVERIFIED AND SELF-DECLARED. Nobody checked the
 *   number, and anything downstream that cares — sending to it, trusting it
 *   as proof of who somebody is — can see that nobody did.
 */
const RECORD_CUSTOMER: ToolSpec = {
  name: ToolName.RecordCustomer,
  does: 'Records what the customer has told you about themselves: their name, a phone or WhatsApp number, an email address, and the language they asked to be answered in. Pass only what they actually gave — anything left out stays exactly as it is, and nothing here erases what is already held. Contacts are saved UNVERIFIED, cleaned up rather than kept verbatim, and one that cannot be read as a real number or address is REFUSED rather than stored. It will not overwrite a name a colleague recorded; it tells you what is held instead. It returns the record AS IT THEN STANDS, so check what you passed is actually in it before telling them it was saved.',
  when: 'When they tell you their name, give you a contact detail, or ask to be answered in a particular language — and it is not already in <context>. Never for anything you inferred, guessed, or read anywhere other than them saying it about themselves, and never for somebody else they mentioned.',
  effect: ToolEffect.Write,
  args: {
    said_in_message_id: {
      kind: FieldKind.Text,
      note: 'the full id of the message where THEY said it. Required — it is what makes the record checkable. No such message, no record.',
    },
    name: {
      kind: FieldKind.OptionalText,
      note: 'the name they gave for themselves, as they gave it, or null. Never somebody else’s name, never their @handle.',
    },
    first_name: {
      kind: FieldKind.OptionalText,
      note: 'their first name alone, when they made the two clear. Null when they gave one name only — that goes in name.',
    },
    last_name: {
      kind: FieldKind.OptionalText,
      note: 'their surname alone, on the same terms as first_name, or null',
    },
    /*
     * TYPED AS THEY TYPED IT, and normalised on the way in rather than
     * asked for in a particular shape. A model told to send E.164 will
     * invent a country code when the customer did not give one, which is
     * the single worst thing that can happen to a phone number: it is
     * wrong, it looks right, and somebody dials it.
     */
    phone: {
      kind: FieldKind.OptionalText,
      note: 'the phone number exactly as they typed it, spaces and + included, with nothing added. Null if they gave none.',
    },
    whatsapp: {
      kind: FieldKind.OptionalText,
      note: 'a WhatsApp number, on the same terms as phone, when they said it is that one specifically. Null otherwise.',
    },
    country: {
      kind: FieldKind.OptionalText,
      note: 'the country a phone number belongs to, as a two-letter code such as IN or GB — ONLY when THEY said where they are, never guessed from their name or language. Null otherwise; a bare number is still worth passing, and you will be told if it cannot be read without one.',
    },
    email: {
      kind: FieldKind.OptionalText,
      note: 'the email address they gave, or null. Stored lower-cased; one that is not a real address is refused rather than saved.',
    },
    preferred_language: {
      kind: FieldKind.OptionalText,
      note: 'the language they asked to be answered in, as an English name such as Hindi or Marathi — only when they ASKED, not merely because they wrote in it. Null otherwise.',
    },
  },
};

/** Every tool, in the order the model is shown them: reads first, then writes. */
/**
 * What this person has earned and what they can spend.
 *
 * A WHOLE MODULE NOTHING COULD REACH. Reward wallets, awards, programmes
 * and entitlements have all existed and no tool has ever exposed any of
 * them, so "how many points do I have" was unanswerable by a service that
 * knew the answer exactly.
 *
 * NO REDEMPTION CODES. An entitlement carries one, and it is a bearer
 * value: whoever holds it can spend the reward. This returns that a reward
 * EXISTS, what it is for and when it lapses — never the code itself. That
 * is a deliberate line, not an oversight: a model is an easy thing to talk
 * a code out of, and a code read aloud in a thread somebody else can see is
 * spent by whoever reads it first.
 */
const REWARD_BALANCE: ToolSpec = {
  name: ToolName.RewardBalance,
  does: "Returns what this person has with the business's reward scheme: the balance of each wallet they hold, what is still pending, what they have earned in total, and any rewards currently issued to them with what each is for and when it expires. Ask for history as well and it also returns HOW the balance was reached — each amount, the date, what they did to earn it and which programme granted it. It does NOT return redemption codes.",
  when: 'When they ask about points, balance, cashback, credit, stamps, vouchers, offers they hold, or anything about what they have earned or can spend here. Not for what the business sells.',
  effect: ToolEffect.Read,
  args: {
    /*
     * ON ASK, NOT ALWAYS. "What is my balance" is the common question, and a
     * transaction history on every one of those is a paragraph nobody reads,
     * paid for on every reply. "How did I earn these" is the rarer one, and
     * it is the one this serves.
     */
    history: {
      kind: FieldKind.Count,
      note: 'how many recent entries to return showing how the balance was reached, 0 to 25. Use 0 when they only want the balance. Ask for some when they want to know HOW, WHEN or WHAT FOR they earned it, or when they dispute the number.',
    },
  },
};

/**
 * The same person, everywhere else they have spoken to this business.
 *
 * SIDEWAYS, NOT FURTHER BACK. `get_earlier_messages` reaches deeper into THIS
 * thread; this one reaches into the others, and the difference is not
 * academic. One live record: 32 conversations for a single customer — 26
 * mentions, 5 comment threads and the one direct message the assistant was
 * reading. It told them "I don't have access to personal history" while
 * thirty-one threads sat beside it.
 *
 * A LIST, NOT THE CONTENTS. Each entry says what kind of thing it was, when,
 * how big, and either its running notes or the last thing said in it. That
 * is enough to answer "you asked us about this on the 3rd" without opening
 * thirty-one threads into one prompt.
 */
const OTHER_CONVERSATIONS: ToolSpec = {
  name: ToolName.OtherChats,
  does: 'Lists the OTHER, SEPARATE conversations this business has had with the same person — their comments under posts, their story mentions and tags, reviews, and any other message threads. For each: what kind it was, when it last moved, how many messages, and either its running notes or the last thing said in it. It does NOT return the messages inside them, and it never includes the conversation you are in.',
  when: 'ONLY WHEN THEY NAME SOMEWHERE ELSE — "I commented on your post", "I tagged you in a story", "I left a review" — or after get_earlier_messages has searched this conversation and what they describe is genuinely not in it. "We discussed it before" on its own means this conversation, not another one.',
  effect: ToolEffect.Read,
  args: {
    count: {
      kind: FieldKind.Count,
      note: 'how many to return, newest first, 1 to 20. Ask for a few unless you have reason to look wider.',
    },
  },
};

export const TOOL_SPECS: readonly ToolSpec[] = [
  CUSTOMER_DETAILS,
  MESSAGE,
  HISTORY,
  REWARD_BALANCE,
  OTHER_CONVERSATIONS,
  CALLBACK,
  RECORD_CUSTOMER,
];

export const TOOL_SPEC_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(
  TOOL_SPECS.map((spec) => [spec.name, spec]),
);
