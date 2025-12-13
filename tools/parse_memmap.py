#!/usr/bin/env python3
"""
Parse memory-map.txt into structured JSON for the C64 memory map page.

This script extracts memory location entries from the OCR'd text of
"Mapping the Commodore 64" by Sheldon Leemon and converts them to
a structured JSON format usable by the web interface.
"""

import re
import json
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Optional


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
    # Handle ranges like "56324-56327"
    range_match = re.match(r"(\d+)-(\d+)", addr_str.strip())
    if range_match:
        start = int(range_match.group(1))
        end = int(range_match.group(2))
        return start, end, f"${start:04X}-${end:04X}"

    # Single address
    addr = int(addr_str.strip())
    return addr, None, f"${addr:04X}"


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
    """Extract bit-level descriptions from text."""
    bits = []
    # Pattern: "Bit N:" or "Bits N-M:" followed by description
    bit_pattern = re.compile(
        r"Bit\s+(\d+)(?:-(\d+))?[:\s]+([^\n]+?)(?=\nBit\s+\d|$)",
        re.IGNORECASE | re.DOTALL,
    )

    for match in bit_pattern.finditer(text):
        bit_start = int(match.group(1))
        bit_end = int(match.group(2)) if match.group(2) else None
        bit_desc = match.group(3).strip()
        # Clean up the description
        bit_desc = re.sub(r"\s+", " ", bit_desc)

        bits.append({"bit": bit_start, "bit_end": bit_end, "description": bit_desc})

    return bits


def parse_memmap(text: str) -> list[MemoryEntry]:
    """Parse the memory map text into structured entries."""
    entries = []

    # Primary pattern for location headers:
    # <decimal> $<hex> <NAME>
    # e.g., "0 D6510" or "1 $1 R6510" or "56324 $DC04 TIMALO"
    # Also handles ranges like "56324-56327 $DC04-$DC07"
    # Note: Some entries lack the $ prefix on hex

    location_pattern = re.compile(
        r"^(\d+(?:-\d+)?)\s+\$?([0-9A-Fa-f]+(?:-\$?[0-9A-Fa-f]+)?)\s+([A-Z][A-Z0-9_]*)\s*$",
        re.MULTILINE,
    )

    # Also look for "Location Range:" headers
    range_pattern = re.compile(
        r"Location Range:\s*(\d+)-(\d+)\s*\(\$([0-9A-Fa-f]+)-\s*\$([0-9A-Fa-f]+)\)",
        re.IGNORECASE,
    )

    # Find all location headers
    matches = list(location_pattern.finditer(text))

    for i, match in enumerate(matches):
        addr_str = match.group(1)
        hex_str = match.group(2)
        name = match.group(3)

        # Parse address
        start, end, hex_addr = parse_address(addr_str)

        # Get the text between this match and the next
        start_pos = match.end()
        end_pos = matches[i + 1].start() if i + 1 < len(matches) else len(text)
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

    # Remove common OCR artifacts
    text = text.replace("", "")  # Remove odd characters

    # Normalize whitespace
    text = re.sub(r"[ \t]+", " ", text)

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
