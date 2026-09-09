import { findByProps } from "@vendetta/metro";
import { FluxDispatcher, React, ReactNative, stylesheet } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { getAssetIDByName as getAssetId } from "@vendetta/ui/assets";
import { semanticColors, showInputAlert } from "@vendetta/ui";
import { storage } from "@vendetta/plugin";

let patches: (() => void)[] = [];

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const { ActionSheetRow } = findByProps("ActionSheetRow") ?? {};
const { FormRow } = findByProps("FormRow") ?? {};

const MessageStore = findByProps("getMessage", "getMessages");

const styles = stylesheet.createThemedStyleSheet({
    icon: {
        width: 24,
        height: 24,
        tintColor: semanticColors.INTERACTIVE_NORMAL,
    },
});

type LocalEdit = {
    channelId: string;
    messageId: string;
    content: string;
    updatedAt: number;
};

function ensureLocalEdits(): Record<string, LocalEdit> {
    if (
        !storage.localEdits ||
        typeof storage.localEdits !== "object" ||
        Array.isArray(storage.localEdits)
    ) {
        storage.localEdits = {};
    }

    return storage.localEdits;
}

function getChannelId(message: any): string | null {
    return message?.channel_id ?? message?.channelId ?? null;
}

function getMessageKey(channelId: string | null, messageId: string | null): string | null {
    if (!channelId || !messageId) return null;
    return `${channelId}:${messageId}`;
}

function getKey(message: any): string | null {
    return getMessageKey(getChannelId(message), message?.id ?? null);
}

function getLocalEdit(message: any): LocalEdit | undefined {
    const key = getKey(message);
    if (!key) return undefined;

    return ensureLocalEdits()[key];
}

function hasLocalEdit(message: any): boolean {
    return Boolean(getLocalEdit(message));
}

function saveLocalEdit(message: any, content: string) {
    const channelId = getChannelId(message);
    const messageId = message?.id;

    const key = getMessageKey(channelId, messageId);

    if (!key || !channelId || !messageId) return;

    ensureLocalEdits()[key] = {
        channelId,
        messageId,
        content,
        updatedAt: Date.now(),
    };
}

function removeLocalEdit(message: any) {
    const key = getKey(message);
    if (!key) return;

    delete ensureLocalEdits()[key];
}

function applyLocalEdit(message: any): any {
    if (!message) return message;

    const edit = getLocalEdit(message);

    if (!edit) return message;

    // Don't mutate Discord's original object.
    return {
        ...message,
        content: edit.content,
    };
}

function applyLocalEditInPlace(message: any) {
    if (!message || typeof message !== "object") return;

    const edit = getLocalEdit(message);
    if (!edit) return;

    message.content = edit.content;
}

function collectMessages(
    value: any,
    output: any[] = [],
    seen = new Set<any>(),
    depth = 0,
) {
    if (!value || depth > 8 || output.length >= 200) return output;

    if (typeof value !== "object") return output;
    if (seen.has(value)) return output;

    seen.add(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            collectMessages(item, output, seen, depth + 1);
        }

        return output;
    }

    if (
        value.id &&
        (value.channel_id || value.channelId) &&
        (
            typeof value.content === "string" ||
            value.author ||
            value.attachments
        )
    ) {
        output.push(value);
    }

    for (const key of Object.keys(value).slice(0, 40)) {
        collectMessages(value[key], output, seen, depth + 1);
    }

    return output;
}

function applyEditsToAction(action: any) {
    if (!action) return;

    const messages = collectMessages(action);

    for (const message of messages) {
        applyLocalEditInPlace(message);
    }
}

function forceMessageRefresh(message: any) {
    const channelId = getChannelId(message);
    const id = message?.id;

    if (!channelId || !id) return;

    /*
     * This is only a local UI refresh.
     *
     * The extra property prevents this action from being mistaken
     * for a real Discord server update by this plugin.
     */
    try {
        FluxDispatcher.dispatch({
            type: "MESSAGE_UPDATE",
            channelId,
            id,
            message: applyLocalEdit(message),
            __localMessageEdit: true,
        });
    } catch {
        // Discord's dispatcher can change between versions.
    }
}

function editMessage(message: any) {
    const currentEdit = getLocalEdit(message);
    const currentContent =
        currentEdit?.content ??
        (typeof message?.content === "string" ? message.content : "");

    showInputAlert({
        title: "Edit Message Locally",
        initialValue: currentContent,
        placeholder: "Message content",
        confirmText: "Save",
        cancelText: "Cancel",
        onConfirm: (newContent: string) => {
            saveLocalEdit(message, newContent);

            // Update the object immediately if it is currently displayed.
            applyLocalEditInPlace(message);

            // Ask Discord's UI to render the local version.
            forceMessageRefresh(message);
        },
    });
}

function restoreMessage(message: any) {
    removeLocalEdit(message);

    /*
     * Remove the local override and refresh the message.
     * The original server-side message remains untouched.
     */
    try {
        FluxDispatcher.dispatch({
            type: "MESSAGE_UPDATE",
            channelId: getChannelId(message),
            id: message?.id,
            message: {
                ...message,
                __localMessageEdit: false,
            },
            __localMessageEditRestore: true,
        });
    } catch {
        // Ignore dispatcher changes between Discord versions.
    }
}

function LocalEditRow({ message }: { message: any }) {
    const icon = getAssetId("ic_edit_24px");

    const onPress = () => {
        LazyActionSheet?.hideActionSheet?.();
        editMessage(message);
    };

    if (ActionSheetRow) {
        return (
            <ActionSheetRow
                label={
                    hasLocalEdit(message)
                        ? "Edit Local Message"
                        : "Edit Message Locally"
                }
                icon={
                    <ActionSheetRow.Icon
                        source={icon}
                        IconComponent={() => (
                            <ReactNative.Image
                                resizeMode="cover"
                                style={styles.icon}
                                source={icon}
                            />
                        )}
                    />
                }
                onPress={onPress}
            />
        );
    }

    if (FormRow) {
        return (
            <FormRow
                label={
                    hasLocalEdit(message)
                        ? "Edit Local Message"
                        : "Edit Message Locally"
                }
                leading={<FormRow.Icon source={icon} />}
                onPress={onPress}
            />
        );
    }

    return null;
}

function RestoreLocalEditRow({ message }: { message: any }) {
    const icon = getAssetId("ic_refresh_24px");

    const onPress = () => {
        LazyActionSheet?.hideActionSheet?.();
        restoreMessage(message);
    };

    if (ActionSheetRow) {
        return (
            <ActionSheetRow
                label="Restore Original Message"
                icon={
                    <ActionSheetRow.Icon
                        source={icon}
                        IconComponent={() => (
                            <ReactNative.Image
                                resizeMode="cover"
                                style={styles.icon}
                                source={icon}
                            />
                        )}
                    />
                }
                onPress={onPress}
            />
        );
    }

    if (FormRow) {
        return (
            <FormRow
                label="Restore Original Message"
                leading={<FormRow.Icon source={icon} />}
                onPress={onPress}
            />
        );
    }

    return null;
}

function getActionRows(root: any) {
    /*
     * Same basic strategy as the original HideMessages plugin:
     * locate the array containing the action-sheet buttons.
     */
    const match = findInTree(root, (value: any) => {
        if (!Array.isArray(value) || value.length < 2) return false;

        const hasPressables = value.filter(
            (item: any) =>
                typeof item?.props?.onPress === "function" ||
                typeof item?.props?.onLongPress === "function" ||
                item?.props?.label ||
                item?.props?.title,
        ).length >= 2;

        return hasPressables;
    });

    return match;
}

function findInTree(
    root: any,
    predicate: (value: any) => boolean,
    seen = new Set<any>(),
    depth = 0,
): any {
    if (!root || depth > 8 || seen.has(root)) return null;

    seen.add(root);

    try {
        if (predicate(root)) return root;
    } catch {
        // Ignore malformed React nodes.
    }

    if (Array.isArray(root)) {
        for (const child of root) {
            const result = findInTree(child, predicate, seen, depth + 1);
            if (result) return result;
        }

        return null;
    }

    if (typeof root !== "object") return null;

    if (root.props) {
        const result = findInTree(
            root.props.children,
            predicate,
            seen,
            depth + 1,
        );

        if (result) return result;
    }

    for (const key of Object.keys(root).slice(0, 20)) {
        if (key === "_owner" || key === "_store") continue;

        const result = findInTree(
            root[key],
            predicate,
            seen,
            depth + 1,
        );

        if (result) return result;
    }

    return null;
}

function patchMessageStore() {
    if (!MessageStore) return;

    /*
     * getMessage() is a useful second layer because some Discord
     * components fetch a message directly instead of consuming the
     * dispatcher action.
     */
    if (typeof MessageStore.getMessage === "function") {
        patches.push(
            after("getMessage", MessageStore, ([channelId, messageId], result) => {
                if (!result) return result;

                return applyLocalEdit(result);
            }),
        );
    }

    /*
     * getMessages() normally returns Discord's channel message cache.
     * We patch its get() method and common arrays without replacing
     * Discord's cache itself.
     */
    if (typeof MessageStore.getMessages === "function") {
        patches.push(
            after("getMessages", MessageStore, ([channelId], result) => {
                if (!result || typeof result !== "object") return result;

                const originalGet = result.get;

                if (typeof originalGet === "function" && !result.__localEditPatched) {
                    result.__localEditPatched = true;

                    result.get = function (messageId: string) {
                        return applyLocalEdit(
                            originalGet.call(this, messageId),
                        );
                    };
                }

                if (Array.isArray(result._array)) {
                    result._array = result._array.map(applyLocalEdit);
                }

                if (result._map && typeof result._map === "object") {
                    for (const id of Object.keys(result._map)) {
                        result._map[id] = applyLocalEdit(result._map[id]);
                    }
                }

                return result;
            }),
        );
    }
}

function patchDispatcher() {
    /*
     * This happens before Discord's stores receive the event.
     *
     * If a locally edited message arrives from Discord again, we replace
     * its visible content with our local version.
     */
    patches.push(
        before("dispatch", FluxDispatcher, ([action]) => {
            if (!action || action.__localMessageEdit) return;

            applyEditsToAction(action);
        }),
    );
}

function patchMessageActionSheet() {
    if (!LazyActionSheet) return;

    patches.push(
        before(
            "openLazy",
            LazyActionSheet,
            ([component, key, msg]) => {
                if (key !== "MessageLongPressActionSheet") return;

                const message = msg?.message;

                if (!message || !component?.then) return;

                component
                    .then((instance: any) => {
                        const unpatch = after(
                            "default",
                            instance,
                            (_args: any[], rendered: any) => {
                                React.useEffect(
                                    () => () => unpatch(),
                                    [],
                                );

                                const buttons = getActionRows(rendered);

                                if (!buttons) return;

                                const index = Number.isFinite(
                                    Number(storage.localEditsIndex),
                                )
                                    ? Number(storage.localEditsIndex)
                                    : 2;

                                const rows: any[] = [
                                    <LocalEditRow
                                        key={`local-edit-${message.id}`}
                                        message={message}
                                    />,
                                ];

                                if (hasLocalEdit(message)) {
                                    rows.push(
                                        <RestoreLocalEditRow
                                            key={`local-restore-${message.id}`}
                                            message={message}
                                        />,
                                    );
                                }

                                buttons.splice(index, 0, ...rows);
                            },
                        );
                    })
                    .catch(() => {
                        // Action-sheet internals changed or failed to load.
                    });
            },
        ),
    );
}

function onLoad() {
    if (!LazyActionSheet) return;

    if (
        typeof storage.localEditsIndex !== "string" &&
        typeof storage.localEditsIndex !== "number"
    ) {
        storage.localEditsIndex = 2;
    }

    ensureLocalEdits();

    patchMessageStore();
    patchDispatcher();
    patchMessageActionSheet();
}

export default {
    onLoad,

    onUnload: () => {
        for (const unpatch of patches) {
            try {
                unpatch();
            } catch {
                // Ignore individual patch failures.
            }
        }

        patches = [];
    },
};
