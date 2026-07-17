import {findByProps} from "@vendetta/metro";
import {FluxDispatcher} from "@vendetta/metro/common";
import {after, before} from "@vendetta/patcher";
import {React, ReactNative, stylesheet} from "@vendetta/metro/common";
import {getAssetIDByName as getAssetId} from "@vendetta/ui/assets"
import {findInReactTree} from "@vendetta/utils"
import Settings from "./components/Settings";
import {storage} from "@vendetta/plugin";
import {logger} from "@vendetta";
import {semanticColors} from "@vendetta/ui";


let patches = [];
let pendingDeletes = new Set();

function debugLog(...args) {
    console.log("[HideMessages]", ...args);
    logger.log("HideMessages:", ...args);
}

function debugError(...args) {
    console.error("[HideMessages]", ...args);
    logger.error("HideMessages:", ...args);
}

debugLog("module evaluated");

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const {ActionSheetRow} = findByProps("ActionSheetRow") ?? {};
const {FormRow} = findByProps("FormRow") ?? {};
const styles = stylesheet.createThemedStyleSheet({
    icon: {
        width: 24,
        height: 24,
        tintColor: semanticColors.INTERACTIVE_NORMAL
    }
});

debugLog("module lookup complete", {
    LazyActionSheet: Boolean(LazyActionSheet),
    ActionSheetRow: Boolean(ActionSheetRow),
    FormRow: Boolean(FormRow),
    FluxDispatcher: Boolean(FluxDispatcher),
    React: Boolean(React),
    ReactNative: Boolean(ReactNative)
});

function ensureHiddenMessages() {
    if (!storage.hiddenMessages || typeof storage.hiddenMessages !== "object" || Array.isArray(storage.hiddenMessages)) {
        storage.hiddenMessages = {};
    }

    return storage.hiddenMessages;
}

function getMessageKey(channelId, messageId) {
    if (!channelId || !messageId) return null;
    return `${channelId}:${messageId}`;
}

function getMessageChannelId(message) {
    return message?.channel_id ?? message?.channelId;
}

function addHiddenMessage(message) {
    const channelId = getMessageChannelId(message);
    const key = getMessageKey(channelId, message?.id);
    if (!key) {
        debugError("Could not persist hidden message; missing ids", describeMessage(message));
        return;
    }

    const hiddenMessages = ensureHiddenMessages();
    hiddenMessages[key] = {
        channelId,
        id: message.id,
        hiddenAt: Date.now()
    };
    debugLog("Persisted hidden message", key, Object.keys(hiddenMessages).length);
}

function isHiddenMessage(message) {
    const channelId = getMessageChannelId(message);
    const key = getMessageKey(channelId, message?.id);
    return Boolean(key && ensureHiddenMessages()[key]);
}

function dispatchDelete(channelId, id, reason) {
    const key = getMessageKey(channelId, id);
    if (!key) return;

    if (pendingDeletes.has(key)) {
        debugLog("Delete already pending", key, reason);
        return;
    }

    pendingDeletes.add(key);
    setTimeout(() => {
        try {
            debugLog("Dispatching persisted MESSAGE_DELETE", {key, reason});
            FluxDispatcher.dispatch({
                type: "MESSAGE_DELETE",
                channelId,
                id,
                __vml_cleanup: true,
                otherPluginBypass: true
            });
        } catch (error) {
            debugError("Failed to dispatch persisted MESSAGE_DELETE", key, error);
        } finally {
            pendingDeletes.delete(key);
        }
    }, 0);
}

function dispatchDeleteForMessage(message, reason) {
    dispatchDelete(getMessageChannelId(message), message?.id, reason);
}

function replayHiddenMessages(reason) {
    const hiddenMessages = ensureHiddenMessages();
    const entries = Object.entries(hiddenMessages);
    debugLog("Replaying hidden messages", {reason, count: entries.length});

    for (const [key, value] of entries) {
        const channelId = value?.channelId ?? key.split(":")[0];
        const id = value?.id ?? key.split(":")[1];
        dispatchDelete(channelId, id, reason);
    }
}

function collectMessages(value, output = [], seen = new Set(), depth = 0) {
    if (!value || depth > 8 || output.length >= 200) return output;
    if (typeof value !== "object") return output;
    if (seen.has(value)) return output;
    seen.add(value);

    if (Array.isArray(value)) {
        for (const item of value) collectMessages(item, output, seen, depth + 1);
        return output;
    }

    if (value.id && (value.channel_id || value.channelId)) {
        output.push(value);
    }

    for (const key of Object.keys(value).slice(0, 40)) {
        collectMessages(value[key], output, seen, depth + 1);
    }

    return output;
}

function applyHiddenMessagesFromAction(action) {
    if (!action || action.type === "MESSAGE_DELETE") return;

    const hiddenMessages = ensureHiddenMessages();
    if (Object.keys(hiddenMessages).length === 0) return;

    const messages = collectMessages(action);
    const hiddenMatches = messages.filter(isHiddenMessage);
    if (hiddenMatches.length === 0) return;

    debugLog("Found hidden messages in dispatcher action", {
        type: action.type,
        count: hiddenMatches.length,
        messages: hiddenMatches.slice(0, 10).map(describeMessage)
    });

    for (const message of hiddenMatches) {
        dispatchDeleteForMessage(message, `dispatcher:${action.type}`);
    }
}

function describeValue(value) {
    try {
        if (value == null) return String(value);
        if (typeof value !== "object") return `${typeof value}:${String(value)}`;
        if (Array.isArray(value)) return `array:${value.length}`;

        const keys = Object.keys(value).slice(0, 12).join(",");
        return `${value.constructor?.name ?? "object"}:{${keys}}`;
    } catch (error) {
        return `uninspectable:${error?.message ?? String(error)}`;
    }
}

function describeMessage(message) {
    try {
        if (!message) return "none";
        return JSON.stringify({
            id: message.id,
            channel_id: message.channel_id,
            channelId: message.channelId,
            authorId: message.author?.id,
            content: typeof message.content === "string" ? message.content.slice(0, 60) : undefined
        });
    } catch (error) {
        return `uninspectable:${error?.message ?? String(error)}`;
    }
}

function getElementName(element) {
    try {
        const type = element?.type;
        if (!type) return typeof element;
        return type.displayName || type.name || type.render?.name || type.type?.name || String(type);
    } catch (error) {
        return `unknown:${error?.message ?? String(error)}`;
    }
}

function describeReactCandidates(root) {
    const candidates = [];
    const seen = new Set();

    function visit(value, path, depth) {
        if (!value || depth > 8 || candidates.length >= 40) return;
        if (typeof value !== "object") return;
        if (seen.has(value)) return;
        seen.add(value);

        if (Array.isArray(value)) {
            const elementNames = value
                .slice(0, 8)
                .map((item) => getElementName(item));

            if (value.length > 0 && elementNames.some((name) => name && name !== "undefined")) {
                candidates.push({
                    path,
                    length: value.length,
                    names: elementNames.join("|")
                });
            }

            value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
            return;
        }

        if (value.props) {
            visit(value.props.children, `${path}.props.children`, depth + 1);
            visit(value.props, `${path}.props`, depth + 1);
        }

        for (const key of Object.keys(value).slice(0, 20)) {
            if (key === "props" || key === "_owner" || key === "_store") continue;
            visit(value[key], `${path}.${key}`, depth + 1);
        }
    }

    visit(root, "root", 0);
    return candidates;
}

function findActionRows(root) {
    const oldMatch = findInReactTree(root, x => x?.[0]?.type?.name === "ButtonRow");
    if (oldMatch) return {buttons: oldMatch, strategy: "ButtonRow"};

    const broadMatch = findInReactTree(root, x => {
        if (!Array.isArray(x) || x.length < 2) return false;

        const names = x.map((item) => getElementName(item));
        const hasRows = names.filter((name) =>
            /row|button|action|pressable|touchable/i.test(name)
        ).length >= 2;

        const hasPressables = x.filter((item) =>
            typeof item?.props?.onPress === "function" ||
            typeof item?.props?.onLongPress === "function" ||
            item?.props?.label ||
            item?.props?.title
        ).length >= 2;

        return hasRows || hasPressables;
    });

    if (broadMatch) return {buttons: broadMatch, strategy: "broad-row-array"};

    return {buttons: null, strategy: "none"};
}

function HideMessageRow({message}) {
    debugLog("Rendering HideMessageRow", describeMessage(message));

    const icon = getAssetId("ic_close_16px");
    debugLog("Resolved icon", icon);

    const onPress = () => {
        debugLog("Hide Message pressed", describeMessage(message));

        addHiddenMessage(message);
        dispatchDeleteForMessage(message, "button-press");

        LazyActionSheet.hideActionSheet();
        debugLog("Hidden action sheet");
    };

    if (ActionSheetRow) {
        debugLog("Using ActionSheetRow");
        return <ActionSheetRow
            label="Hide Message"
            icon={<ActionSheetRow.Icon
                source={icon}
                IconComponent={() => {
                    debugLog("Rendering ActionSheetRow icon");
                    return <ReactNative.Image resizeMode="cover" style={styles.icon} source={icon} />;
                }}
            />}
            onPress={onPress}
        />;
    }

    if (FormRow) {
        debugLog("Using FormRow fallback");
        return <FormRow
            label="Hide Message"
            leading={<FormRow.Icon source={icon} />}
            onPress={onPress}
        />;
    }

    debugError("Could not find ActionSheetRow or FormRow");
    return null;
}

function onLoad() {
    debugLog("onLoad start");
    debugLog("Module availability", {
        LazyActionSheet: Boolean(LazyActionSheet),
        ActionSheetRow: Boolean(ActionSheetRow),
        FormRow: Boolean(FormRow),
        FluxDispatcher: Boolean(FluxDispatcher),
        React: Boolean(React),
        ReactNative: Boolean(ReactNative)
    });

    if (!LazyActionSheet) {
        debugError("Could not find LazyActionSheet");
        return;
    }

    debugLog("Index at", storage.hideMessagesIndex);
    ensureHiddenMessages();
    replayHiddenMessages("onLoad");

    patches.push(after("dispatch", FluxDispatcher, ([action]) => {
        applyHiddenMessagesFromAction(action);
    }));
    debugLog("Installed FluxDispatcher replay patch");

    debugLog("Installing openLazy before patch");

    patches.push(before("openLazy", LazyActionSheet, ([component, key, msg]) => {
        debugLog("openLazy called", {
            key,
            component: describeValue(component),
            msg: describeValue(msg),
            msgKeys: msg ? Object.keys(msg).join(",") : "none",
            message: describeMessage(msg?.message)
        });

        const message = msg?.message;
        if (key != "MessageLongPressActionSheet") {
            debugLog("Ignoring action sheet key", key);
            return;
        }

        if (!message) {
            debugError("MessageLongPressActionSheet had no msg.message", describeValue(msg));
            return;
        }

        if (!component?.then) {
            debugError("Action sheet component is not thenable", describeValue(component));
            return;
        }

        debugLog("Waiting for action sheet component promise", describeMessage(message));

        component.then(instance => {
            debugLog("Action sheet component resolved", describeValue(instance));

            const unpatch = after("default", instance, (_, component) => {
                debugLog("Action sheet default rendered", describeValue(component));

                React.useEffect(() => () => {
                    debugLog("Unpatching action sheet default");
                    unpatch()
                }, [])

                const candidates = describeReactCandidates(component);
                debugLog("Action sheet tree candidates", JSON.stringify(candidates));

                const {buttons, strategy} = findActionRows(component);
                if (buttons) debugLog("Found action row list", {strategy, length: buttons.length, names: buttons.slice(0, 8).map(getElementName).join("|")});

                if (!buttons) {
                    debugError("Could not find action sheet button list");
                    return
                }

                const index = Number.isFinite(Number(storage.hideMessagesIndex)) ? Number(storage.hideMessagesIndex) : 2;
                debugLog("Inserting row", {index, beforeLength: buttons.length});
                buttons.splice(index, 0, <HideMessageRow message={message} />)
                debugLog("Inserted row", {afterLength: buttons.length});
            })
            debugLog("Installed default render patch");
        }).catch(error => {
            debugError("Action sheet component promise failed", error);
        });
    }));

    debugLog("openLazy before patch installed", patches.length);
}

export default {
    onLoad,
    onUnload: () => {
        debugLog("onUnload start", patches.length);
        for (const unpatch of patches) {
            unpatch();
        }
        patches = [];
        debugLog("onUnload complete");
    },

    settings: Settings
}
