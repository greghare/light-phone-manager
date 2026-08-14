# Notes CRUD helper for the bundled Light CLI runtime.
#
# The `light` CLI itself (light_cli_tui, driven by run_light.py) only
# exposes `notes list/add/download` — no edit, delete, or single-note fetch.
# Its underlying library, light_api (a dependency of light_cli_tui and so
# already vendored alongside it — see scripts/fetch-light-cli.js), has the
# full set (get_notes, get_note_content, get_note_metadata,
# create_text_note, update_note_title, update_note_content, delete_note).
# This talks to that library directly instead of shelling out to a CLI
# command that doesn't exist.
#
# Same credential/device-selection flags as `light` itself, and the same
# `{"data": ..., "error": string|null}` JSON-on-stdout contract as `light
# --json`, so light.js's existing runJson() handles this output unchanged.
#
# Usage: <python> -I notes_cli.py <list|get|create|update|delete> [note_id]
#          [--title T] [--content C] [--device-id ID | --phone-number N]
import argparse
import json
import sys

from light_api.client import Light


def note_to_dict(note, content=None):
    d = {
        "id": note.id,
        "fileId": note.file_id,
        "noteType": note.note_type,
        "title": note.title,
        "updatedAt": note.updated_at,
    }
    if content is not None:
        d["content"] = content
    return d


def cmd_list(light, args):
    notes = light.notes.get_notes()
    result = []
    for note in notes:
        d = note_to_dict(note)
        if args.preview:
            # Same N+1 (a presigned GET URL + HTTP fetch per note) the `light`
            # CLI's own `notes list --content-preview` does — there's no
            # cheaper way to get a snippet, per its cli.py. Fine for a
            # personal note list; the renderer shows a loading state while
            # this runs.
            d["preview"] = None
            if note.note_type != "audio":
                content = light.notes.get_note_content(note)
                text = content.decode("utf-8", errors="replace") if content else ""
                first_line = text.splitlines()[0].strip() if text.strip() else ""
                d["preview"] = first_line or None
        result.append(d)
    return result


def cmd_get(light, args):
    note = light.notes.get_note_metadata(args.note_id)
    # Audio notes have no editable text content — the UI this feeds only
    # supports text notes, so leave "content" out rather than shipping raw
    # audio bytes nowhere useful.
    content = None
    if note.note_type != "audio":
        content = light.notes.get_note_content(note).decode("utf-8", errors="replace")
    return note_to_dict(note, content)


def cmd_create(light, args):
    note = light.notes.create_text_note(args.title or "Untitled", args.content or "")
    return note_to_dict(note, args.content or "")


def cmd_update(light, args):
    note = light.notes.get_note_metadata(args.note_id)
    if args.title is not None:
        light.notes.update_note_title(note, args.title)
    if args.content is not None:
        light.notes.update_note_content(note, args.content.encode("utf-8"))
    note = light.notes.get_note_metadata(args.note_id)
    return note_to_dict(note, args.content)


def cmd_delete(light, args):
    light.notes.delete_note(args.note_id)
    return None


COMMANDS = {
    "list": cmd_list,
    "get": cmd_get,
    "create": cmd_create,
    "update": cmd_update,
    "delete": cmd_delete,
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=sorted(COMMANDS))
    parser.add_argument("note_id", nargs="?")
    parser.add_argument("--title", default=None)
    parser.add_argument("--content", default=None)
    parser.add_argument("--preview", action="store_true", help="list: include a one-line content preview per note.")
    parser.add_argument("--email", default=None)
    parser.add_argument("--email-file", default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--password-file", default=None)
    parser.add_argument("--phone-number", default=None)
    parser.add_argument("--phone-number-file", default=None)
    parser.add_argument("--device-id", default=None)
    parser.add_argument("--device-id-file", default=None)
    args = parser.parse_args()

    try:
        with Light(
            email=args.email,
            email_file=args.email_file,
            password=args.password,
            password_file=args.password_file,
            phone=args.phone_number,
            phone_file=args.phone_number_file,
            device_id=args.device_id,
            device_id_file=args.device_id_file,
        ) as light:
            data = COMMANDS[args.command](light, args)
        print(json.dumps({"data": data, "error": None}))
    except Exception as e:
        print(json.dumps({"data": None, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
