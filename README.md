# aws-cli-saml-headless-symantecvip

Get temporary AWS CLI credentials via STS Assume Role w/ SAML using token retrieved via Enterprise Symantec VIP MFA login.

## Sample Conf file
EMAIL=my.id
PASS=myPass
URL=https://mydirectory.com/adfs/ls/idpinitiatedsignon.aspx
IDPNAME=myIDPName