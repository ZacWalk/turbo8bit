#!/usr/bin/env python3
"""
Parse memory-map.txt into structured JSON for the C64 memory map page.

This script extracts memory location entries from the OCR'd text of
"Mapping the Commodore 64" by Sheldon Leemon and converts them to
a structured JSON format usable by the web interface.
"""

import re
import json
import warnings
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Optional


# Exact source headings only: these repairs do not rewrite narrative text or
# guess between conflicting, otherwise valid decimal/hexadecimal addresses.
HEADER_CORRECTIONS = {
    "$0 D6510": "0 $0 D6510",
    "1 15-138 $73-$8il CHRGET": "115-138 $73-$8A CHRGET",
    "776-771 $308-$309 IGONE": "776-777 $308-$309 IGONE",
    "54272 $D400 FRELOl": "54272 $D400 FRELO1",
    "54276 $D404 VCREGl": "54276 $D404 VCREG1",
    "56320 $DCOO CIAPRA": "56320 $DC00 CIAPRA",
    "56576 $DDOO CI2PRA": "56576 $DD00 CI2PRA",
}


@dataclass
class MemoryEntry:
    """A single memory location or range entry."""

    address: int  # Starting address
    address_end: Optional[int]  # Ending address (for ranges)
    hex_addr: str  # Hex representation
    name: str  # Common name/label (e.g., "LORAM", "HIRAM")
    title: str  # Descriptive title
    description: str  # Full description text
    region: str  # Memory region this belongs to
    bits: list  # Bit-level descriptions if applicable


def parse_address(addr_str: str) -> tuple[int, Optional[int], str]:
    """Parse address string like '1' or '56324-56327' into (start, end, hex)."""
    match = re.fullmatch(r"(\d+)(?:-(\d+))?", addr_str.strip())
    if not match:
        raise ValueError(f"Invalid address: {addr_str!r}")
    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) else None
    if not 0 <= start <= (end if end is not None else start) <= 0xFFFF:
        raise ValueError(f"Invalid address range: {addr_str!r}")
    hex_addr = f"${start:04X}"
    if end is not None:
        hex_addr += f"-${end:04X}"
    return start, end, hex_addr


def determine_region(address: int) -> str:
    """Determine which memory region an address belongs to."""
    if address <= 0x00FF:
        return "zeropage"
    elif address <= 0x01FF:
        return "stack"
    elif address <= 0x03FF:
        return "lowram"
    elif address <= 0x07FF:
        return "screen"  # Default screen memory
    elif address <= 0x9FFF:
        return "ram"  # General RAM / BASIC area
    elif address <= 0xBFFF:
        return "basic"  # BASIC ROM area
    elif address <= 0xCFFF:
        return "highram"
    elif address <= 0xD3FF:
        return "vic"  # VIC-II registers
    elif address <= 0xD7FF:
        return "sid"  # SID registers
    elif address <= 0xDBFF:
        return "colorram"  # Color RAM
    elif address <= 0xDCFF:
        return "cia1"  # CIA #1
    elif address <= 0xDDFF:
        return "cia2"  # CIA #2
    elif address <= 0xDFFF:
        return "io"  # I/O area
    else:
        return "kernal"  # Kernal ROM area


def parse_bits(text: str) -> list:
    """Extract explicit bit-field headings and their wrapped first paragraph."""
    bits = []
    heading = re.compile(
        r"^Bits?[ \t]+([0-7])(?:[ \t]*-[ \t]*([0-7]))?[ \t]*:[ \t]*(.*)$",
        re.IGNORECASE,
    )
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = heading.match(line.strip())
        if not match:
            continue
        bit_start = int(match.group(1))
        bit_end = int(match.group(2)) if match.group(2) else None
        paragraph = [match.group(3)]
        for continuation in lines[index + 1 :]:
            continuation = continuation.strip()
            if not continuation or heading.match(continuation):
                break
            paragraph.append(continuation)
        bit_desc = re.sub(r"\s+", " ", " ".join(paragraph)).strip()
        bits.append({"bit": bit_start, "bit_end": bit_end, "description": bit_desc})
    return bits


def parse_memmap(text: str) -> list[MemoryEntry]:
    """Parse validated headings in the book's address-ordered chapters.

    Token tables inside the ROM chapters contain low-valued decimal/hex pairs,
    but they are not a second zero-page chapter. Ambiguous address pairs are
    omitted with a warning rather than publishing a guessed address.
    """
    entries = []

    # Primary pattern for location headers:
    # <decimal> $<hex> <NAME>
    # e.g., "0 $0 D6510" or "1 $1 R6510" or "56324 $DC04 TIMALO"
    # Also handles ranges like "56324-56327 $DC04-$DC07"
    # Note: Some entries lack the $ prefix on hex

    location_pattern = re.compile(
        r"^(\d+(?:-\d+)?)[ \t]+\$?([0-9A-Fa-f]+(?:-\$?[0-9A-Fa-f]+)?)[ \t]+([A-Z][A-Z0-9_]*)[ \t]*$",
        re.MULTILINE,
    )

    # Rejected address headings still bound content; token-table rows do not.
    matches: list[tuple[re.Match[str], bool]] = []
    past_zero_page = False
    for match in location_pattern.finditer(text):
        try:
            start, end, _ = parse_address(match.group(1))
            hex_addresses = [
                int(part, 16) for part in match.group(2).replace("$", "").split("-")
            ]
            if hex_addresses != ([start, end] if end is not None else [start]):
                raise ValueError("Decimal and hexadecimal addresses disagree")
        except ValueError:
            warnings.warn(
                f"Skipping inconsistent address header: {match.group(0).strip()}",
                stacklevel=2,
            )
            matches.append((match, False))
            continue
        if past_zero_page and start < 0x100:
            continue
        past_zero_page |= start >= 0x100
        matches.append((match, True))

    for i, (match, valid) in enumerate(matches):
        if not valid:
            continue
        addr_str = match.group(1)
        name = match.group(3)

        # Parse address
        start, end, hex_addr = parse_address(addr_str)

        # Get the text between this match and the next
        start_pos = match.end()
        end_pos = matches[i + 1][0].start() if i + 1 < len(matches) else len(text)
        content = text[start_pos:end_pos].strip()

        # Extract title (first line/paragraph before detailed description)
        lines = content.split("\n")
        title_lines = []
        desc_lines = []
        in_title = True

        for line in lines:
            line = line.strip()
            if not line:
                if title_lines:
                    in_title = False
                continue

            # Title is usually the first paragraph (before first blank line)
            if in_title:
                # Stop if we hit a "Bit" description
                if re.match(r"^Bits?\s+\d", line, re.IGNORECASE):
                    in_title = False
                    desc_lines.append(line)
                else:
                    title_lines.append(line)
            else:
                desc_lines.append(line)

        title = " ".join(title_lines)
        # Clean up title
        title = re.sub(r"\s+", " ", title).strip()

        description = "\n".join(desc_lines)
        # Clean up description
        description = re.sub(r"\n\s*\n\s*\n+", "\n\n", description).strip()

        # Parse bit descriptions
        bits = parse_bits(content)

        # Determine region
        region = determine_region(start)

        entry = MemoryEntry(
            address=start,
            address_end=end,
            hex_addr=hex_addr,
            name=name,
            title=title,
            description=description,
            region=region,
            bits=bits,
        )
        entries.append(entry)

    return entries


def clean_ocr_text(text: str) -> str:
    """Clean up OCR artifacts from the text."""
    # Remove page numbers and headers
    text = re.sub(r"^\d+\s*$", "", text, flags=re.MULTILINE)

    # Normalize whitespace
    text = re.sub(r"[ \t]+", " ", text)
    text = "\n".join(
        HEADER_CORRECTIONS.get(line.strip(), line) for line in text.splitlines()
    )

    return text


def main():
    """Main entry point."""
    # Find the memory-map.txt file
    script_dir = Path(__file__).parent
    repo_root = script_dir.parent
    memmap_file = repo_root / "memory-map.txt"

    if not memmap_file.exists():
        print(f"Error: {memmap_file} not found")
        return 1

    print(f"Reading {memmap_file}...")
    text = memmap_file.read_text(encoding="utf-8", errors="replace")

    print("Cleaning OCR text...")
    text = clean_ocr_text(text)

    print("Parsing memory locations...")
    entries = parse_memmap(text)

    print(f"Found {len(entries)} memory location entries")

    # Convert to JSON-serializable format
    data = {
        "source": "Mapping the Commodore 64 by Sheldon Leemon",
        "entries": [asdict(e) for e in entries],
    }

    # Write output
    output_file = repo_root / "web" / "static" / "js" / "memmap-data.json"
    print(f"Writing {output_file}...")

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    print("Done!")

    # Print summary by region
    from collections import Counter

    regions = Counter(e.region for e in entries)
    print("\nEntries by region:")
    for region, count in regions.most_common():
        print(f"  {region}: {count}")

    # Print first few entries as sample
    print("\nSample entries:")
    for entry in entries[:5]:
        print(f"  ${entry.address:04X} {entry.name}: {entry.title[:60]}...")

    return 0


if __name__ == "__main__":
    exit(main())
