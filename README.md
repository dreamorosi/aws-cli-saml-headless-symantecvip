# aws-cli-saml-headless-symantecvip

Get temporary AWS CLI credentials via STS Assume Role w/ SAML using token retrieved via Enterprise Symantec VIP MFA login.

## Sample Conf file
```txt
EMAIL=my.id
PASS=myPass
URL=https://mydirectory.com/adfs/ls/idpinitiatedsignon.aspx?loginToRp=urn:amazon:webservices
DURATION_SECONDS=10800
```

## Further readings
* [AWS Docs - About SAML 2.0-based Federation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_saml.html)
* [AWS Docs - Enabling SAML 2.0 Federated Users to Access the AWS Management Console](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_enable-console-saml.html)
* [AWS Docs - Configuring SAML Assertions for the Authentication Response](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_saml_assertions.html)
* [AWS Docs - AssumeRoleWithSAML](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithSAML.html)