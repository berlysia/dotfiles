UA_IPHONE='"Mozilla/5.0 (iPhone; CPU iPhone OS 10_3_2 like Mac OS X) AppleWebKit/603.2.4 (KHTML, like Gecko) Version/10.0 Mobile/14F89 Safari/602.1"'
REDIRECTION=' 2> /dev/null'
CHROME_PATH='/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome'

alias chrome=$CHROME_PATH

alias chrome_g="chrome --profile-directory='chrome_g' --user-agent=$UA_IPHONE $REDIRECTION"
alias chrome_m="chrome --profile-directory='chrome_m' --user-agent=$UA_IPHONE $REDIRECTION"
alias chrome_sub="chrome --profile-directory='subacc' --user-agent=$UA_IPHONE $REDIRECTION"
