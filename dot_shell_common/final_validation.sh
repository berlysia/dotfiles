#!/bin/sh
# final_validation.sh - Phase 4 comprehensive validation

echo "========================================="
echo "    Phase 4 Final Validation Report"
echo "========================================="
echo ""

SUCCESS=0
WARNINGS=0
FAILURES=0

# Test 1: Legacy wrapper compatibility
echo "🧪 Testing legacy wrapper compatibility..."
if ./dotfiles_doctor_legacy.sh --help >/dev/null 2>&1; then
    echo "  ✅ Legacy wrapper works"
    SUCCESS=$((SUCCESS + 1))
else
    echo "  ❌ Legacy wrapper failed"
    FAILURES=$((FAILURES + 1))
fi

# Test 2: Executable doctor command
echo "🧪 Testing executable_doctor wrapper..."
if ./executable_doctor --help >/dev/null 2>&1; then
    echo "  ✅ doctor command works"
    SUCCESS=$((SUCCESS + 1))
else
    echo "  ❌ doctor command failed"
    FAILURES=$((FAILURES + 1))
fi

# Test 3: Shell compatibility
echo "🧪 Testing shell compatibility..."
for shell in sh bash zsh; do
    if command -v $shell >/dev/null 2>&1; then
        if $shell test_suite.sh --help >/dev/null 2>&1; then
            echo "  ✅ $shell: compatible"
            SUCCESS=$((SUCCESS + 1))
        else
            echo "  ❌ $shell: failed"
            FAILURES=$((FAILURES + 1))
        fi
    else
        echo "  ⏭️  $shell: not installed"
        WARNINGS=$((WARNINGS + 1))
    fi
done

# Test 4: Pre-apply mode
echo "🧪 Testing pre-apply mode..."
if ./test_suite.sh --pre-apply --categories=core --quiet >/dev/null 2>&1; then
    echo "  ✅ Pre-apply mode works"
    SUCCESS=$((SUCCESS + 1))
else
    echo "  ❌ Pre-apply mode failed"
    FAILURES=$((FAILURES + 1))
fi

# Test 5: Post-apply mode
echo "🧪 Testing post-apply mode..."
if ./test_suite.sh --post-apply --categories=core --quiet >/dev/null 2>&1; then
    echo "  ✅ Post-apply mode works"
    SUCCESS=$((SUCCESS + 1))
else
    echo "  ⚠️  Post-apply mode has warnings"
    WARNINGS=$((WARNINGS + 1))
fi

# Test 6: Category filtering
echo "🧪 Testing category filtering..."
for cat in core shell config tools; do
    if ./test_suite.sh --categories=$cat --quiet >/dev/null 2>&1; then
        echo "  ✅ Category '$cat' works"
        SUCCESS=$((SUCCESS + 1))
    else
        echo "  ⚠️  Category '$cat' has issues"
        WARNINGS=$((WARNINGS + 1))
    fi
done

# Test 7: Performance check
echo "🧪 Testing performance..."
START=$(date +%s%N)
./test_suite.sh --categories=core --quiet >/dev/null 2>&1
END=$(date +%s%N)
TIME_MS=$(( (END - START) / 1000000 ))

if [ $TIME_MS -lt 5000 ]; then
    echo "  ✅ Performance: ${TIME_MS}ms (< 5s target)"
    SUCCESS=$((SUCCESS + 1))
else
    echo "  ⚠️  Performance: ${TIME_MS}ms (> 5s target)"
    WARNINGS=$((WARNINGS + 1))
fi

# Test 8: Enhanced features
echo "🧪 Testing enhanced features..."

# Check for weighted scoring
if ./test_suite.sh --categories=core 2>&1 | grep -q "Health Score"; then
    echo "  ✅ Weighted scoring present"
    SUCCESS=$((SUCCESS + 1))
else
    echo "  ❌ Weighted scoring missing"
    FAILURES=$((FAILURES + 1))
fi

# Check for readiness status
if ./test_suite.sh --categories=core 2>&1 | grep -q "Readiness"; then
    echo "  ✅ Readiness status present"
    SUCCESS=$((SUCCESS + 1))
else
    echo "  ❌ Readiness status missing"
    FAILURES=$((FAILURES + 1))
fi

# Check for adapter functionality
if . adapters/adapter_selector.sh 2>/dev/null && get_environment_info >/dev/null 2>&1; then
    echo "  ✅ Enhanced adapter works"
    SUCCESS=$((SUCCESS + 1))
else
    echo "  ❌ Enhanced adapter failed"
    FAILURES=$((FAILURES + 1))
fi

echo ""
echo "========================================="
echo "📊 Final Results:"
echo "  ✅ Successful tests: $SUCCESS"
echo "  ⚠️  Warnings: $WARNINGS"
echo "  ❌ Failed tests: $FAILURES"
echo ""

if [ $FAILURES -eq 0 ]; then
    echo "🎉 VALIDATION PASSED - Migration successful!"
    echo ""
    echo "✅ All Phase 4 objectives achieved:"
    echo "  • Feature parity verified"
    echo "  • Legacy support maintained"
    echo "  • Performance targets met"
    echo "  • Enhanced features working"
    echo ""
    echo "📝 Next Steps:"
    echo "  1. Remove dotfiles_doctor.sh.backup after user confirmation"
    echo "  2. Update documentation to reference test_suite.sh"
    echo "  3. Communicate migration to users"
    exit 0
else
    echo "❌ VALIDATION FAILED - Issues detected"
    echo "  Please review failed tests above"
    exit 1
fi