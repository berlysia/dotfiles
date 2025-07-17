#\!/bin/bash
# Simple command statistics generator
LOG_FILE="$1"
if [ -z "$LOG_FILE" ]; then
    LOG_FILE=".claude/log/command_execution.log"
fi

echo "# Command Execution Statistics"
echo "Generated: $(date)"
echo

echo "## Total Commands: $(wc -l < "$LOG_FILE")"
echo

echo "## Most Frequent Commands:"
# New format only: timestamp|command_id|timing_ms|command|description
grep -v "^$" "$LOG_FILE" | cut -d'|' -f4 | grep -v "^$" | awk '{print $1}' | sort | uniq -c | sort -nr | head -10

echo
echo "## Average Execution Times by Command:"
grep "ms" "$LOG_FILE" | while IFS='|' read -r timestamp command_id timing_ms command description; do
    if [ -n "$command" ] && [ -n "$timing_ms" ]; then
        base_cmd=$(echo "$command" | awk '{print $1}')
        time_ms=$(echo "$timing_ms" | sed 's/ms//')
        echo "$base_cmd:$time_ms"
    fi
done | awk -F: '{sum[$1]+=$2; count[$1]++} END {for(cmd in sum) printf "%-20s %d ms (avg from %d executions)\n", cmd, sum[cmd]/count[cmd], count[cmd]}' | sort -k2 -n
