#!/bin/bash
echo "--- Running: license-checker ---"
yarn dlx license-checker --failOn 'GPL;LGPL;EPL-1.0;EPL-2.0;CPL-1.0' --exclude 'MIT,BSD,ISC,Apache-2.0,CC0-1.0,Artistic-2.0'

yarn_audit () {
    ENVIRONMENT=$1
    ARGUMENTS=$2
    ENVIRONMENT_ARG=""
    if [[ "$ENVIRONMENT" != "" ]]
    then
        ENVIRONMENT_ARG="--environment $ENVIRONMENT"
    fi
    echo "--- Running: yarn npm audit [$ENVIRONMENT] [$ARGUMENTS] ---"
    yarn npm audit -A -R $ENVIRONMENT_ARG $ARGUMENTS
    EXITCODE=$?
    STATUS="UNKNOWN"
    if [[ $EXITCODE -gt 0 ]]
    then   
        STATUS="\e[31mFailed\e[0m"
    else
        STATUS="\e[32mPassed\e[0m"
    fi
    echo -e "--- Finished: yarn npm audit [$ENVIRONMENT]. Status: $STATUS ---"
    return $EXITCODE 
}

yarn_audit production "--severity high --no-deprecations"
DEPENDENCY_CODE=$?
if [[ $DEPENDENCY_CODE -gt 0 ]]
then
    exit $DEPENDENCY_CODE
fi

yarn_audit development "--severity high --no-deprecations"
DEV_DEPENDENCY_CODE=$?
if [[ $DEV_DEPENDENCY_CODE -gt 0 ]]
then
    exit 101
fi

exit 0