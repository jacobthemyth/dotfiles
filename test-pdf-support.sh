#!/bin/bash
# Test if llm CLI supports PDF attachments

echo "Testing PDF support with gpt-4o-mini..."
llm "List all the task titles you see in this PDF" \
  -a things-2025-11-16-222127.pdf \
  -m gpt-4o-mini 2>&1

exit_code=$?
if [ $exit_code -eq 0 ]; then
  echo ""
  echo "✓ PDF support works with gpt-4o-mini!"
else
  echo ""
  echo "✗ PDF support failed (exit code: $exit_code)"
fi
